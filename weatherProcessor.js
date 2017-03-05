var async = require( 'async' )
var request = require( 'request' )
var pg = require( 'pg' )

const argv = require( 'yargs' )
    .default( 'delay', 600000 ) // ten minutes
    .number( 'delay' )
    .describe( 'delay', 'Milliseconds server will check POSTGIS DB for null weather information.' )
    .describe( 'pgUser', 'POSTGIS DB username' )
    .describe( 'pgPass', 'POSTGIS DB password' )
    .describe( 'pgHost', 'POSTGIS host address' )
    .describe( 'pgPort', 'POSTGIS host port' )
    .describe( 'pgDb', 'POSTGIS database' )
    .describe( 'key', 'Dark Sky API key' )
    .demandOption([ 'pgUser', 'pgPass', 'pgHost', 'pgPort', 'pgDb', 'key' ])
    .help( 'h' )
    .argv
    
// create a pool connection since multiple parts of the application will be
// making queries against the database at different times
var pool = new pg.Pool({
    user: argv.pgUser,
    password: argv.pgPass,
    host: argv.pgHost,
    port: argv.pgPort,
    database: argv.pgDb
})

// create an async queue to process tasks
// a task is the documents with null information from the POSTGIS DB
//
// there is no throttle requirement on the Dark Sky API; however,
// the queue is limited to single concurrency so the API doesn't think
// we're DOSing them or something
var queue = async.queue( function( task, callback ) {
    // convert JS timestamp to UNIX integer
    var unixTimestamp = Math.round( (new Date( task.timestamp )).getTime() / 1000 )
    var geom = JSON.parse( task.geom )
    // build the API query
    var url = `https://api.darksky.net/forecast/${ argv.key }/${ geom.coordinates[1] },${ geom.coordinates[0] },${ unixTimestamp }?exclude=minutely,hourly,daily,flags`

    // there's really no point in handling errors and retrying the request, since no weather info
    // will be updated on the record, and the record will be picked up again on the next pass
    request( url, function( err, res, body ) {
        if ( err ) {
            console.log( 'ForecastIO API GET error:', err )
        } else {
            task.weather = res.body
        }
        callback()
    })
}, 1 )

// when the last task returns, sleep until delay has elapsed, then do it again
queue.drain = function() {
    console.log( 'Completed ForecastIO requests.' )
    console.log( `Will check for more in ${ argv.delay } ms...` )
    setTimeout( resetQueue, argv.delay )
}

// update the weather info on the record in the POSTGIS DB
function updateDoc( doc ) {
    console.log( 'Updating', doc.id )
    pool.query( `update samples set weather = '${ doc.weather }' where id = '${ doc.id }';` )
        .then( res => console.log( `Successfully updated ${ doc.id }!` ) )
        .catch( err => console.log( `Error updating ${ doc.id }:`, err ) )
}

// populate the queue with tasks
// get any records without weather info
function resetQueue() {
    pool.query( 'select id, timestamp, ST_AsGeoJSON( geom ) as geom from samples where weather is NULL;' )
        .then( function( res ) {
            if ( res.rows.length == 0 ) return queue.drain()
            res.rows.forEach( rec => queue.push( rec, ( err => updateDoc( rec ) ) ) )
        })
        .catch( err => console.log( 'Error querying samples:', err ) )
}

// initially populate the queue
resetQueue()


// EXPRESS SERVER
// this just serves our simple Leaflet app with point data
var express = require( 'express' )
var app = express()

app.use( express.static( 'resources' ) )

app.get( '/index.html', function( req, res ) {
    res.sendFile( 'index.html', { root: __dirname } )
})

app.get( '/samples/all', function( req, res ) {
    pool.query( 'select id, alt, csq, timestamp, weather, ST_AsGeoJSON( geom ) as geom from samples;' )
        .then( function( dbRes ) {
            res.json( dbRes.rows )
        })
        .catch( err => console.log( 'Error fetching all samples:', err ) )
})

app.listen( 4001, function() {
    console.log( 'Web server running on port 4001.' )
})
