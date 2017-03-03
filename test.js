var async = require( 'async' )
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

var commPort = new sp.SerialPort( argv.commPort, {
    baudrate: 9600,
    parser: sp.parsers.readline( '\r\n' )
})

var lastCommData
commPort.on( 'data', function( line ) {
    lastCommData = line
})

var nmeaPort = new sp.SerialPort( argv.nmeaPort, {
    baudrate: 9600,
    parser: sp.parsers.readline( '\r\n' )
})

var lat, lon, alt, updated, csq

nmeaPort.on( 'data', function( line ) {
    var data = parse( line )
    if ( data && data.sentence == 'GGA' ) {
        lat = nmeaToDecimal( data.lat, data.latPole )
        lon = nmeaToDecimal( data.lon, data.lonPole )
        alt = data.alt
        updated = new Date()

        updateCsq()
    }
})

function updateCsq() {
    commPort.write( 'AT+CSQ' ).drain( function( err ) {
        if ( err ) {
            console.log( err )
        } else {
            csq = lastCommData
        }
    })
}

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

function main( host='localhost', port='8125' ) {
    var clock = (new Date()).getTime()

    async.forever(
        function( next ) {
            var cur = (new Date()).getTime()
            //if ( cur >= ( clock + 300000 ) ) { // five minutes
            if ( cur >= ( clock + 5000 ) ) { // five seconds
                clock = cur
                console.log(`
                    \n===== SAMPLE =====\n
                    ${ updated }\n
                    Lat:\t${ lat }\n
                    Lon:\t${ lon }\n
                    Alt:\t${ alt }\n
                    Csq:\t${ csq }
                `)
            }
        },
        function( err ) {
            console.log( err )
        }
}
