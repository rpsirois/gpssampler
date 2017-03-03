var async = require( 'async' )
var PouchDB = require( 'pouchdb' )
var sp = require( 'serialport' )
var nmea = require( 'nmea' )

const argv = require( 'yargs' )
    .default( 'nmeaPort', 'COM4' )
    .default( 'commPort', 'COM6' )
    .default( 'list', false )
    .argv

if ( argv.list ) {
    sp.list( function( err, ports ) {
        ports.forEach( function( port ) {
            console.log( port )
        })
    })
}

// port for issuing AT commands
var commPort = new sp.SerialPort( argv.commPort, {
    baudrate: 9600,
    parser: sp.parsers.readline( '\r\n' )
})

var lastCommData
commPort.on( 'data', function( line ) {
    var idx = line.indexOf( '+CSQ: ' )

    if ( idx >= 0 ) {
        lastCommData = line.substr( 6 )
    }
})

// port for listening to NMEA data
var nmeaPort = new sp.SerialPort( argv.nmeaPort, {
    baudrate: 9600,
    parser: sp.parsers.readline( '\r\n' )
})

// vars
var lat, lon, alt, updated, csq, prevLat, prevLon

nmeaPort.on( 'data', function( line ) {
    var data = parse( line )
    if ( data && data.sentence == 'GGA' ) {
        prevLat = lat
        prevLon = lon
        lat = nmeaToDecimal( data.lat, data.latPole )
        lon = nmeaToDecimal( data.lon, data.lonPole )
        alt = data.alt
        updated = new Date()

        updateCsq()
    }
})

function updateCsq( cb ) {
    commPort.write( 'AT+CSQ\r\n', function( err ) {
        if ( err ) {
            console.log( err )
        } else {
            commPort.drain( function( err ) {
                if ( err ) {
                    console.log( err )
                } else {
                    csq = lastCommData
                    if ( cb ) cb( csq )
                }
            })
        }
    })
}


// utilites
function parse( line ) {
    try {
        return nmea.parse( line )
    } catch( err ) {
        return null
    }
}

function nmeaToDecimal( dmStr, dir ) {
    var idx = dmStr.indexOf( '.' ) - 2
    if ( idx < 0 ) idx = 0

    var minutes = Number( dmStr.substr( idx ) )
    var degrees = Number( dmStr.substr( 0, idx ) )
    var decimal = degrees + ( minutes / 60 )

    if ( dir == 'S' || dir == 'W' ) decimal = decimal * -1

    return decimal
}

function haversine( ll1, ll2, r ) {
    const deltaLat = dToR( ll2[0] - ll1[0] )
    const deltaLon = dToR( ll2[1] - ll1[1] )
    const a =
        Math.sin( deltaLat / 2 ) * Math.sin( deltaLat / 2 ) +
        Math.cos( dToR( ll1[0] ) ) * Math.cos( dToR( ll2[0] ) ) *
        Math.sin( deltaLon / 2 ) * Math.sin( deltaLon / 2 )
    const c = 2 * Math.atan2( Math.sqrt( a ), Math.sqrt( 1 - a ) )
    return r * c
}

function commitSample( db, doc ) {
    db.post( doc )
}


// main program loop
function main() {
    var clock = (new Date()).getTime()
    var db = new PouchDB( 'samples' )

    async.forever(
        function( next ) {
            var cur = (new Date()).getTime()
            //if ( cur >= ( clock + 300000 ) ) { // five minutes
            if ( cur >= ( clock + 5000 ) ) { // five seconds
                clock = cur
                const doc = {
                    timestamp: updated,
                    lat: lat,
                    lon: lon,
                    alt: alt,
                    csq: csq
                }

                // only commit the sample if there's a significant enough change in distance from the last sample
                var committed = false
                if ( typeof prevLat != 'undefined' && typeof prevLon != 'undefined' ) {
                    if ( haversine( [ prevLat, prevLon ], [ lat, lon ], 6371e3 ) > 800 ) { // arbitrarily 800 meters difference (~ 1/2 mile)
                        commitSample( db, doc )
                        committed = true
                    }
                } else {
                    commitSample( db, doc )
                    committed = true
                }

                console.log(`
                    \n===== SAMPLE =====\n
                    ${ updated }\n
                    Lat:\t${ lat }\n
                    Lon:\t${ lon }\n
                    Alt:\t${ alt }\n
                    Csq:\t${ csq }\n
                    Committed? ${ committed }
                `)

                db.allDocs( { include_docs: true }, function( err, docs ) {
                    console.log( docs )
                })
            }
            next()
        },
        function( err ) {
            console.log( err )
        }
    )
}

main()
