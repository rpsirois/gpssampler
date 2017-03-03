var async = require( 'async' )
var PouchDB = require( 'pouchdb' )
var pg = require( 'pg' )
var SerialPort = require( 'serialport' )
var nmea = require( 'nmea' )

const argv = require( 'yargs' )
    .default( 'nmeaPort', 'COM4' )
    .default( 'commPort', 'COM6' )
    .argv

// port for issuing AT commands
var commPort = new SerialPort( argv.commPort, {
    baudrate: 9600,
    parser: SerialPort.parsers.readline( '\r\n' )
})

var lastCommData
commPort.on( 'data', function( line ) {
    var idx = line.indexOf( '+CSQ: ' )

    if ( idx >= 0 ) {
        lastCommData = line.substr( 6 )
    }
})

// port for listening to NMEA data
var nmeaPort = new SerialPort( argv.nmeaPort, {
    baudrate: 9600,
    parser: SerialPort.parsers.readline( '\r\n' )
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

function dToR( d ) { return d * ( Math.PI / 180 ) }

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
    var sampleClock = (new Date()).getTime()
    var syncClock = (new Date()).getTime()
    var db = new PouchDB( 'samples' )

    // sampling loop
    async.forever(
        function( next ) {
            var cur = (new Date()).getTime()
            //if ( cur >= ( sampleClock + 300000 ) ) { // five minutes
            if ( cur >= ( sampleClock + 5000 ) ) { // five seconds
                sampleClock = cur

                if ( typeof csq != 'undefined' ) { // csq data may not be ready yet
                    const doc = {
                        timestamp: updated,
                        lat: lat,
                        lon: lon,
                        alt: alt,
                        csq: csq,
                        syncd: false
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

                    /*
                    console.log(`
                        \n===== SAMPLE =====\n
                        ${ updated }\n
                        Lat:\t${ lat }\n
                        Lon:\t${ lon }\n
                        Alt:\t${ alt }\n
                        Csq:\t${ csq }\n
                        Committed? ${ committed }
                    `)
                    */
                }
            }
            next()
        },
        function( err ) {
            console.log( 'SAMPLE LOOP ERR', err )
        }
    )

    // postgis synchoronization loop
    async.forever(
        function( next ) {
            var cur = (new Date()).getTime()
            //if ( cur >= ( syncClock + 3.6e6 ) ) { // one hour
            if ( cur >= ( syncClock + 10000 ) ) { // ten seconds
                syncClock = cur

                console.log( 'Starting PostGIS connection.' )
                pg.connect({
                    user: 'postgres',
                    password: 'password',
                    host: '138.68.45.102',
                    port: 5984,
                    database: 'gpssamples'
                }, function( err, client, done ) {
                    console.log( 'Getting all the PouchDB samples for sync' )
                    db.allDocs( { include_docs: true }, function( pouchErr, res ) {
                        if ( pouchErr ) {
                            console.log( 'SYNC POUCHDB ERR', pouchErr )
                        } else {
                            console.log( `DB size == ${ res.rows.length }` )

                            // zomg really need to write a view for this
                            res.rows.forEach( function( record ) {
                                var doc = record.doc

                                if ( !doc.syncd ) {
                                    console.log( 'Syncing', doc )
                                    client.query(
                                        'insert into samples values ( $1::text, $2, $3::text, $4::text, ST_SetSRID( ST_MakePoint( $5, $6 ), 4326 ), NULL );',
                                        [ doc._id, doc.alt, doc.csq, doc.timestamp, doc.lon, doc.lat ]
                                    )
                                    .then( function( result ) {
                                        console.log( result )
                                        db.put({
                                            _id: doc._id,
                                            _rev: doc._rev,
                                            syncd: true
                                        })
                                    })
                                    .catch( err => console.log( 'ERR INSERTING POSTGIS RECORD', err ) )
                                }
                            })
                        }
                    })
                    done()
                })
            }
            next()
        },
        function( err ) {
            console.log( 'POSTGIS SYNC ERR', err )
        }
    )
}

main()
