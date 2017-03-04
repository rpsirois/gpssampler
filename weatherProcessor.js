var async = require( 'async' )
var request = require( 'request' )
var pg = require( 'pg' )

var key = '20d13a59dca21f5c664844b791726d68'
var delay = 600000 // ten minutes

var pool = new pg.Pool({
    user: 'postgres',
    password: 'password',
    host: '138.68.45.102',
    port: 5432,
    database: 'gpssamples'
})

var queue = async.queue( function( task, callback ) {
    var unixTimestamp = Math.round( (new Date( task.timestamp )).getTime() / 1000 )
    var geom = JSON.parse( task.geom )
    var url = `https://api.darksky.net/forecast/${ key }/${ geom.coordinates[1] },${ geom.coordinates[0] },${ unixTimestamp }?exclude=minutely,hourly,daily,flags`

    request( url, function( err, res, body ) {
        if ( err ) {
            console.log( 'ForecastIO API GET error:', err )
        } else {
            task.weather = res.body
        }
        callback()
    })
}, 1 )

queue.drain = function() {
    console.log( 'Completed ForecastIO requests.' )
    console.log( `Will check for more in ${ delay } ms...` )
    setTimeout( resetQueue, delay )
}

function updateDoc( doc ) {
    console.log( 'Updating', doc.id )
    pool.query( `update samples set weather = '${ doc.weather }' where id = '${ doc.id }';` )
        .then( res => console.log( `Successfully updated ${ doc.id }!` ) )
        .catch( err => console.log( `Error updating ${ doc.id }:`, err ) )
}

function resetQueue() {
    pool.query( 'select id, timestamp, ST_AsGeoJSON( geom ) as geom from samples where weather is NULL;' )
        .then( function( res ) {
            if ( res.rows.length == 0 ) return queue.drain()
            res.rows.forEach( rec => queue.push( rec, ( err => updateDoc( rec ) ) ) )
        })
        .catch( err => console.log( 'Error querying samples:', err ) )
}

resetQueue()


// EXPRESS SERVER
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
