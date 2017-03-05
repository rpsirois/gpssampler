## GPS Sampler

![Example image from Leaflet app](https://github.com/rpsirois/gpssampler/blob/master/example.jpg)

Client will listen for NMEA data on configured COM port, as well as issue AT+CSQ command on configured COM port in order to sample GPS data along with RSSI information.

Client then caches samples locally (see brainstorm image) and synchronizes them with a POST GIS server.

Weather processor queries POST GIS database for records without weather information, and then retroactively marries that information to the records via the Dark Sky API.

Weather processor also serves a simple Leaflet app for viewing samples point data.

### Processor
- **TODO 1:** Create a much more detailed Leaflet app to show binned data and different dimensions (weather, time of day, etc.).
- **TODO 2:** Create a reports module for the app to give high level statistics.

### Client Program
- **TODO 1:** Discuss some different methods for sampling data. Currently, the only configurable options are the interval, and distance from last sampled location.

### Etc.
Finally, this code still requires extensive testing. Only several small tests have been run to debug the code itself, and not the entire tech stack.

Feel free to use this how you wish, I put it under MIT license.
