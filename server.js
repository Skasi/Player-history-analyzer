/*
CHEAT SHEET FOR CONSOLE TEXT HIGHLIGHTING
 \x1b  followed by...
 
 [0m  # reset
 [1m  # hicolor
 [7m  # inverse background and foreground
      
[30m  # foreground black       [40m  # background black
[31m  # foreground red         [41m  # background red
[32m  # foreground green       [42m  # background green
[33m  # foreground yellow      [43m  # background yellow
[34m  # foreground blue        [44m  # background blue
[35m  # foreground magenta     [45m  # background magenta
[36m  # foreground cyan        [46m  # background cyan
[37m  # foreground white       [47m  # background white

example:
console.log("\x1b[7mInitializing server..\x1b[0m")
*/

/*
!!!!!!!!! TODO: Either merge timeline data with match or send both seperately or idk what.

TODO: Add some sort of intervall to update items and champions every now and then for when new stuff is released - don't forget to reset: items = {}
TODO (fallback): Remember match histories for players. Only use these cached histories if riot servers are unresponsive. Remember the longest and most recent match histories, then pick whichever has sufficient data.
TODO: Theoretically users might be able to send 10000 single requests and could cause the queue to never start a timeout.
TODO: list of users needs to be split up in FIRST-TIMERS and OLD REQUESTERS
newcommers will be added at the END of the FIRST-TIMERS queue
FIRST-TIMERS will come BEFORE the group of OLD REQUESTERS
TODO: Consider if newcommers should have to wait until OLD REQUESTERS are complete.
Also consider giving OLD REQUESTERS with few requests a slightly higher priority over those with many requests.
This might be obsolete though as those with few requests are completed sooner anyway.
Just make sure that people can not somehow completely block other people by filling up the queue like crazy.
TODO (performance): Make queues per-region for expected 2x speed on high usage.
TODO (performance): To improve the speed for users, have a separate queue for DB and API requests. Only add requests to the API queue if they are not in DB. Request all matches in a single batch and only add them to the API request queue if a match is not available.
TODO (done?): Deal with matches that were sent before a user made a new request but are recieved after this request. (done via socket.once and similar?)
*/

console.log("\x1b[7mInitializing server..\x1b[0m")

// INITIALIZE SERVER STUFF

// server libs
var express = require("express")
var app = express()
var server = require("http").Server(app)
var io = require("socket.io")(server) // socketio for communicating with the client

// other libs
var levelup = require('levelup') // Responsible for accessing local database
var requestLib = require("request") // Responsible for sending requests to Riot
var semver = require('semver') // Used to compare API's version numbering for item lists, eg: semver.gt('1.2.3', '9.8.7') // false
var apiKey = require("./APIKEY") // File storing the API key
var config = require("./config") // Different configuration variables

// Initialize database for matches
var matchDB = levelup('./matchDB')
var itemDB = levelup('./itemDB')

// Set "default entry" directory to /static/
app.use(express.static("static"))
// Forward requests to /client.html
app.get("/", function (req, res) {
	res.sendFile(__dirname + "/client.html")
})

// listen to port
if (process.env.PORT) {
	server.listen(parseInt(process.env.PORT))
} else {
	server.listen(80)
}

// Counters
var retryAfters = 0

// API REQUEST FUNCTION
// converts a "simple" request to a more precise request for the request library
function request(db, url, action) {
	var config = {
		url: url+"&api_key="+apiKey,
		timeout: 120000, // two minute timeout
		json: true, gzip: true, jar: false
	}
	
	// Only check database if one is defined
	if (db) {
		//console.log("Looking for", url, "in DB.")
		db.get(url, (dbError, value) => {
			// Data not in DB
			if (dbError) {
				
				if (!dbError.notFound)
					console.log("\x1b[1m\x1b[31mGET ERROR:\n", dbError, "\x1b[0m")
				
				// If value not in DB, request from API directly
				requestLib(config, (error, response, body) => {
					action(error, response, body)
					
					retryHandler(response)
					
					if (response && response.statusCode === 200) {
						// Store data in DB
						console.log("Storing data to DB:", url)
						db.put(url, JSON.stringify(body), (putError) => {
							if (putError)
								console.log("\x1b[1m\x1b[31mPUT ERROR:\n", putError, "\x1b[0m")
						})
					}
				})
				
				return
			}
			
			// If data was in DB, then don't wait 1s before requesting the next thing
			requestQueue.retryAfter(0)
			
			action(dbError, null, JSON.parse(value))
		})
	// Otherwise request from API directly
	} else {
		requestLib(config, (error, response, body) => {
			action(error, response, body)
			
			retryHandler(response)
		})
	}
}

function retryHandler(response) {
	// Wait out retry-after and add some extra time just to be safe
	if (response && response.headers["retry-after"]) {
		retryAfters++
		console.log("\x1b[1m\x1b[31mSERVER SENT RETRY-AFTER FOR A TOTAL OF", retryAfters, "TIMES NOW\x1b[0m")
		// Add an extra 1s on the first-ever retra-after, scaling cubically with further retry-afters: 8s, 27s, 64s, ...
		requestQueue.retryAfter(response.headers["retry-after"] * 1000 + Math.pow(retryAfters, 3) * 1000)
	}
}

// A queue of user requests that will potentially be forwarded to riot servers.
class Queue {
	constructor(/*region for a later version*/) {
		// region for a later version
		// this.region = region
		// array of { socket: socket, pending: [requestOrder1, requestOrder2, ...] } where socket is used as an identifier
		this.users = []
		// timeout working through the queue
		this.timeout
	}
	
	start(timer = config.queueTimer) { // 1200 for dev key, 3.3333 for standard api key
		// TODO: Add sanity check to warn in case of empty queue
		if (!this.timeout)  {
			//console.log("Starting queue timeout.")
			var t = this
			this.timeout = setTimeout(() => {
				t.timeout = false
				t.next()
			}, timer)
		}
		//else console.log("Queue timeout already running!")
	}
	
	stop() {
		if (this.timeout) {
			//console.log("Stopping queue timeout!")
			clearTimeout(this.timeout)
			this.timeout = false
		}
		else
			console.log("Can't stop - no timeout running!")
	}
	
	// For when the the API throws a 429 and suggests a Retry-After
	// Caller needs to make sure to convert the delay from date or seconds to milliseconds
	retryAfter(delay) {
		// Only retryAfter if timeout already running
		if (!this.timeout) {
			console.log("\x1b[1mTimeout not running, cannot delay\x1b[0m")
			return
		}
		
		this.stop()
		if (delay > 0)
			console.log("\x1b[1mRetrying after", delay, "ms\x1b[0m")
		this.start(delay)
	}
	
	// get next socket and run their next requestOrder
	next() {
		// Error when queue empty
		if (this.users.length === 0 || this.users[0].pending.length === 0) {
			console.error("QUEUE WAS ALREADY EMPTY! PANIC!")
			return
		}
		
		var requestOrder = this.users[0].pending.shift()
		request(requestOrder.db, requestOrder.url, requestOrder.action)
		// Move user to end of list after their requestOrder was sent
		this.users.push(this.users.shift())
		// Remove socket from list of users if all requestOrders are complete
		if (this.users[0].pending.length === 0) {
			console.log("No more requests for user", this.users[0].socket.id, ".")
			this.users.shift()
		}
		// Start new timeout if list of users is not empty yet
		if (this.users.length > 0) {
			console.log("Queue: ", this.users.length, "user(s) remaining, ", this.users[0].pending.length, "request(s) queued for next user.")
			this.start()
		}
	}
	
	// add request to start of specified socket's list of requestOrders
	prepend(socket, requestOrder) {
		var u = this.users.find(u => u.socket === socket)
		// user exists, add order to start
		if (u)
			u.pending.unshift(requestOrder)
		// user doesn't exist, add new user to start of queue with order
		else
			this.users.unshift({socket: socket, pending: [requestOrder]})
		
		this.start()
	}
	
	// add request to end of specified socket's list of requestOrders
	append(socket, requestOrder) {
		var u = this.users.find(u => u.socket === socket)
		// user exists, add order to end
		if (u)
			u.pending.push(requestOrder)
		// user doesn't exist, add new user to start of queue with order
		else
			this.users.unshift({socket: socket, pending: [requestOrder]})
		
		this.start()
	}
	
	clear(socket) {
		// Keep every socket except for the one to be cleared
		this.users = this.users.filter(u => u.socket !== socket)
	}
}

var requestQueue = new Queue()


// HANDLING SOCKET CONNECTIONS
io.on("connection", (socket) => {
	console.log("\nNEW CONNECTION!\n")
	
	socket.emit("latestVersion", latestVersion, () => { console.log("player received latest version") })
	socket.emit("champions", champions, () => { console.log("player received champions") })
	socket.emit("items", items, () => { console.log("player received items") })
	
	socket.on("summoner", (data) => {
		// attempt at ensuring data is safe and not completely messed up
		if (typeof data !== "object") {
			console.log("aborting summoner request - user's data not an object")
			return
		}
		if (!data.region || !data.username) {
			console.log("aborting summoner request - user's data insufficient")
			return
		}
		for (var key in data) {
			data[key] = encodeURIComponent(data[key])
			if (!["region", "username"].includes(key)) {
				console.log("aborting summoner request - user's request contained additional key:", key)
				return
			}
		}
		
		// Requesting Summoner info
		queueSummoner(socket, data)
	})
	
	socket.on("request", (data) => {
		requestQueue.clear(socket)
		
		console.log("new request:", data)
		
		// attempt at ensuring data is safe and not completely messed up
		if (typeof data !== "object") {
			console.log("aborting matchhistory request - user's data not an object")
			return
		}
		if (!data.region || !data.username || typeof(data.beginIndex) !== "number" || data.beginIndex < 0 || typeof(data.endIndex) !== "number" || data.endIndex < 1 || data.beginIndex >= data.endIndex) {
			console.log("aborting matchhistory request - user's data insufficient")
			return
		}
		for (var key in data) {
			data[key] = encodeURIComponent(data[key])
			if (!["region", "username", "championId", "beginIndex", "endIndex", "beginTime", "endTime"].includes(key)) {
				console.log("aborting matchhistory request - user's request contained additional key:", key)
				return
			}
		}
		
		// Requesting Summoner info
		queueSummoner(socket, data, true)
	})
	
	// Log certain messages the client sends for debugging purpose
	//socket.on("log", (msg) => { console.log("\x1b[7mClient sent message:\n"+msg+"\x1b[0m") })
	
	socket.on("stop", () => {
		console.log("stopping")
		requestQueue.clear(socket)
	})
	
	socket.on("disconnect", () => {
		console.log("connection closed")
		requestQueue.clear(socket)
	})
})

// function to call itself for retries
function queueSummoner(socket, data, queueWithMatchlist) {
	requestQueue.append(
		socket,
		{
			db: null,
			url: "https://"+data.region+".api.riotgames.com/lol/summoner/v3/summoners/by-name/"+data.username+"?",
			action: (error, response, summonerData) => {
				if (error || (response && response.statusCode != 200)) {
					// log potential network error
					if (error)
						console.log("REQUEST ERROR for summoner\n", data, "\nerror:\n", error)
					
					// re-queue if error or 429 (retry-after is handled by request)
					if (error || response.statusCode == 429 || response.statusCode == 500 || response.statusCode == 503)
						queueSummoner.apply(this, arguments)
					else if (response.statusCode == 404) {
						console.log("Summoner not found")
						socket.emit("summoner")
						if (queueWithMatchlist)
							socket.emit("warning", "Summoner not found.")
					} else {
						socket.emit("warning", "Riot API sent " + response.statusCode + " status code.")
					}
					return
				}
				
				// send summoner info (id) to user
				console.log("sending summoner data")
				socket.emit("summoner", summonerData)
				
				// optional callback for queuing matchlist
				if (queueWithMatchlist) {
					// prepare matchlist url
					var matchlistUrl = "https://"+data.region+".api.riotgames.com/lol/match/v3/matchlists/by-account/"+summonerData.accountId+"?champion="+(data.championId || "")+"&beginTime="+(data.beginTime || "")+"&endTime="+(data.endTime || "")+"&beginIndex="+(data.beginIndex || 0)+"&endIndex="+(data.endIndex || 100)
					queueMatchlist(socket, matchlistUrl)
				}
			}
		}
	)
}

// function to call itself for retries
function queueMatchlist(socket, matchlistUrl) {
	console.log("adding request for matchlist to queue, url:\n", matchlistUrl)
	requestQueue.append(
		socket,
		{
			db: null,
			url: matchlistUrl,
			action: (error, response, matchlistData) => {
				// TODO: Consider rewriting all error-handlers to look like the following if-condition.
				// TODO: Consider a function (name, url) where name eg. "matchlist"
				if (error || (response && response.statusCode != 200)) {
					if (error)
						console.log("REQUEST ERROR for matchlist\n", matchlistUrl, "\nerror:\n", error)
					else
						console.log("REQUEST ERROR for matchlist\n", matchlistUrl, "\nstatus code:\n", response.statusCode)
					
					// re-queue if error or 429 (retry-after is handled by request)
					if (error || response.statusCode == 429 || response.statusCode == 500 || response.statusCode == 503)
						queueMatchlist.apply(this, arguments)
					else if (response.statusCode == 404) {
						console.log("No matchlist found")
						socket.emit("warning", "No matchlist found")
					} else {
						socket.emit("warning", "Riot API sent " + response.statusCode + " status code.")
					}
					return
				}
				
				if (matchlistData.endIndex == 0 || !matchlistData.matches) {
					console.log("Matchlist empty")
					socket.emit("warning", "Matchlist empty")
					return
				}
				
				console.log("sending matchlist")
				socket.emit("matchlist", { matchlistUrl: matchlistUrl, matchlist: matchlistData })
				
				for (var i = 0; i < matchlistData.matches.length; i++) {
					var match = matchlistData.matches[i]
					match.platformId = match.platformId.toLowerCase()
					
					// prepare match url
					var matchUrl = "https://"+match.platformId+".api.riotgames.com/lol/match/v3/matches/"+match.gameId+"?"
					queueMatch(socket, matchUrl)
				}
			}
		}
	)
}

// function to call itself for retries
function queueMatch(socket, matchUrl) {
	requestQueue.append(
		socket,
		{
			db: matchDB,
			url: matchUrl,
			action: (error, response, body) => {
				if (error || (response && response.statusCode != 200)) {
					if (error)
						console.log("REQUEST ERROR for match\n", matchUrl, "error:\n", error)
					else
						console.log("REQUEST ERROR for match\n", matchUrl, "response:\n", response.statusCode)
				
					// re-queue if error or 429 (retry-after is handled by request)
					if (error || response.statusCode == 429 || response.statusCode == 500 || response.statusCode == 503)
						//!! TODO: 503s could be handled by temporarily increasing the delay between requestQueue using a less-"extreme" retryAfter
						queueMatch.apply(this, arguments)
					return
				}
			
				//console.log("sending match to user")
				socket.emit("match", body)
			}
		}
	)
}

// function to call itself for retries
function queueLeague(socket, leagueUrl) {
	var leagueUrl = "https://"+data.region+".api.riotgames.com/lol/league/v3/positions/by-summoner/"+summonerId+"?"
	requestQueue.append(
		socket,
		{
			db: matchDB,
			url: matchUrl,
			action: (error, response, body) => {
				if (error || (response && response.statusCode != 200)) {
					if (error)
						console.log("REQUEST ERROR for league\n", matchUrl, "error:\n", error)
					else
						console.log("REQUEST ERROR for league\n", matchUrl, "response:\n", response.statusCode)
				
					// re-queue if error or 429 (retry-after is handled by request)
					if (error || response.statusCode == 429 || response.statusCode == 500 || response.statusCode == 503)
						//!! TODO: 503s could be handled by temporarily increasing the delay between requestQueue using a less-"extreme" retryAfter
						queueLeague.apply(this, arguments)
					return
				}
			
				//console.log("sending league to user")
				socket.emit("league", body)
			}
		}
	)
}

// GET STATIC DATA FROM RITO ONCE

// Item info
var items = {}
var itemsVersion = "0.0.0"
function requestItems(url) {
	request(itemDB, url, (error, response, msg) => {
		if (error || (response && response.statusCode != 200)) {
			console.log("PROBLEM! Couldn't get ITEM data. Retrying.")
			if (error || (response && response.statusCode == 429))
				requestItems(url)
			return
		}
		console.log("Got ITEM data for version " + msg.version + ".")
		
		// Check if version of received list is newer or outdated, then merge data, prioritizing newer versions' data
		// Object.assign prioritizes data from later object over prior ones
		if (semver.gt(msg.version, itemsVersion)) {
			itemsVersion = msg.version
			// received itemlist has a newer version than the latest checked
			items = Object.assign(items, msg.data)
		} else
			// received itemlist has an older version than the latest checked
			items = Object.assign(msg.data, items)
	})
}

// Champion info
var champions
function requestChampion(url) {
	console.log("Requesting champions.")
	request(null, url, (error, response, msg) => {
		if (error || (response && response.statusCode != 200)) {
			console.log("PROBLEM! Couldn't get CHAMPION data. Retrying.")
			if (error || (response && response.statusCode == 429))
				requestChampion(url)
			return
		}
		console.log("Got CHAMPION data.")
		champions = msg.data
	})
}

// Versions
var latestVersion
function requestVersions(url) {
	console.log("Requesting versions.")
	request(null, url, (error, response, msg) => {
		if (error || (response && response.statusCode != 200)) {
			console.log("PROBLEM! Couldn't get ITEM data. Retrying.")
			if (error || (response && response.statusCode == 429))
				requestVersions(url)
			return
		}
		console.log("Got VERSION data.")
		
		latestVersion = msg[0]
		
		for (var i in msg) {
			console.log("Requesting items for version " + msg[i] + ".")
			requestItems("https://euw1.api.riotgames.com/lol/static-data/v3/items?tags=from&tags=into&locale=en_US&version=" + msg[i])
		}
	})
}

// Request game versions to then be able to request items for the different game versions
requestVersions("https://euw1.api.riotgames.com/lol/static-data/v3/versions?")
requestChampion("https://euw1.api.riotgames.com/lol/static-data/v3/champions?locale=en_US&dataById=true")


// Handle shutdown command
process.on("SIGINT", () => {
	console.log("SHUTTING DOWN")
	matchDB.close()
	process.exit()
})


console.log("Server initialization complete.")