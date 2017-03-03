var sp = require( 'serialport' )
var nmea = require( 'nmea' )

const argv = require( 'yargs' )
    .default( 'port', 'COM4' )
    .default( 'samples', null )
    .default( 'list', false )
    .argv

if ( argv.list ) {
    sp.list( function( err, ports ) {
        ports.forEach( function( port ) {
            console.log( port )
        })
    })
}

var port = new sp.SerialPort( argv.port, {
    baudrate: 9600,
    parser: sp.parsers.readline( '\r\n' )
})

var countSamples = argv.samples

port.on( 'data', function( line ) {
    if ( typeof argv.samples == 'number' ) {
        if ( countSamples > 0 ) print( line )
    } else {
        print( line )
    }
})

function print( line ) {
    console.log( nmea.parse( line ) )
}
