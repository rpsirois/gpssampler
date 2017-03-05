var async = require( 'async' )
var PouchDB = require( 'pouchdb' )
var pg = require( 'pg' )
var SerialPort = require( 'serialport' )
var nmea = require( 'nmea' )

const argv = require( 'yargs' )
    .default( 'nmeaPort', 'COM4' )
    .default( 'commPort', 'COM6' )
    .default( 'sampleInterval', 300000 ) // five minutes
    .describe( 'sampleInterval', 'Milliseconds between each sample attempt.' )
    .number( 'sampleInterval' )
    .default( 'syncInterval', 3.6e6 ) // one hour
    .describe( 'syncInterval', 'Milliseconds between each POSTGIS DB synchronization.' )
    .number( 'syncInterval' )
    .default( 'sampleDiff', 800 )
    .describe( 'sampleDiff', 'Threshold distance in meters since last sample before new sample is recorded.' )
    .number( 'sampleDiff' )
    .describe( 'pgUser', 'POSTGIS DB username' )
    .describe( 'pgPass', 'POSTGIS DB password' )
    .describe( 'pgHost', 'POSTGIS host address' )
    .describe( 'pgPort', 'POSTGIS host port' )
    .describe( 'pgDb', 'POSTGIS database' )
    .demandOption([ 'pgUser', 'pgPass', 'pgHost', 'pgPort', 'pgDb', 'key' ])
    .help( 'h' )
    .argv

// port for issuing AT commands
var commPort = new SerialPort( argv.commPort, {
    baudrate: 9600,
    parser: SerialPort.parsers.readline( '\r\n' )
})

// listen to AT command responses
var lastCommData
commPort.on( 'data', function( line ) {
    var idx = line.indexOf( '+CSQ: ' )

    // only store data if it's the CSQ response
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

// continually update data as it comes in
// if there's a parse error, that particular sample will just be skipped
nmeaPort.on( 'data', function( line ) {
    var data = parse( line )

    // GGA sentences contain the GPS fix info we are looking for
    if ( data && data.sentence == 'GGA' ) {
        prevLat = lat
        prevLon = lon
        lat = nmeaToDecimal( data.lat, data.latPole )
        lon = nmeaToDecimal( data.lon, data.lonPole )
        alt = data.alt
        updated = new Date()

        // send the AT command for CSQ each time we sample GGA info
        updateCsq()
    }
})

// fn to send AT command for RSSI information
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

// convert from NMEA format (d)ddmm.mmmm to decimal
function nmeaToDecimal( dmStr, dir ) {
    var idx = dmStr.indexOf( '.' ) - 2
    if ( idx < 0 ) idx = 0

    var minutes = Number( dmStr.substr( idx ) )
    var degrees = Number( dmStr.substr( 0, idx ) )
    var decimal = degrees + ( minutes / 60 )

    if ( dir == 'S' || dir == 'W' ) decimal = decimal * -1

    return decimal
}

// lat/lon utilities for determining distance between
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

// save record in local PouchDB instance
function commitSample( db, doc ) {
    db.post( doc )
}

//
// main program loop
//
function main() {
    var sampleClock = (new Date()).getTime()
    var syncClock = (new Date()).getTime()
    var db = new PouchDB( 'samples' )

    // sampling loop
    async.forever(
        function( next ) {
            var cur = (new Date()).getTime()
            if ( cur >= ( sampleClock + argv.sampleInterval ) ) {
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
                } // if csq data isn't there yet, then just skip that sample
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
            // TODO: maybe this should do something more complex based on network speed?
            if ( cur >= ( syncClock + argv.syncInterval ) ) {
                syncClock = cur

                // use a pool since it will manage the connections for us
                var pool = new pg.Pool({
                    user: argv.pgUser,
                    password: argv.pgPass,
                    host: argv.pgHost,
                    port: argv.pgPort,
                    database: argv.pgDb
                })

                // get all local PouchDB records that haven't been sync'd yet
                db.allDocs( { include_docs: true }, function( pouchErr, res ) {
                    if ( pouchErr ) {
                        console.log( 'SYNC POUCHDB ERR', pouchErr )
                    } else {
                        // zomg really need to write a view for this
                        res.rows.forEach( function( record ) {
                            var doc = record.doc

                            // this is lazy - it should be handled in the query
                            if ( !doc.syncd ) {
                                pool.query(`
                                    insert into samples values (
                                        '${ doc._id }',
                                        ${ doc.alt },
                                        '${ doc.csq }',
                                        '${ doc.timestamp }',
                                        NULL,
                                        ST_SetSRID(
                                            ST_MakePoint(
                                                ${ doc.lon },
                                                ${ doc.lat }
                                            )
                                        , 4326 )
                                    );
                                `)
                                .then( function( result ) {
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
            }
            next()
        },
        function( err ) {
            console.log( 'POSTGIS SYNC ERR', err )
        }
    )
}

main()
