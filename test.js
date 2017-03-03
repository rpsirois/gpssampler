var sp = require( 'serialport' )
var nmea = require( 'nmea' )

sp.list( function( err, ports ) {
    ports.forEach( function( port ) {
        console.log( port )
    })
})
