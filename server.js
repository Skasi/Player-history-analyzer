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
TODO:
Remember match histories for players. Only use these cached histories if riot servers are unresponsive.
TODO:
Deal with matches that were sent before a user made a new request but are recieved after this request. (done via socket.once and similar?)
Make queues per-region for expected 2x speed.
Get item data for older versions to reduce the occurance of N/As
*/

console.log("\x1b[7mInitializing server..\x1b[0m")

// INITIALIZE SERVER STUFF
//console.log(this)

// server libs
var express = require("express")
var app = express()
var server = require("http").Server(app)
var io = require("socket.io")(server) // socketio for communicating with the client

// other lib(stuff)
var levelup = require('levelup') // Responsible for accessing local database
var requestLib = require("request") // Responsible for sending requests to Riot
var apiKey = require("./APIKEY") // File storing the API key

// listen to port
if (process.env.PORT) {
	server.listen(parseInt(process.env.PORT))
} else {
	server.listen(80)
}

// Set "default entry" directory to /static/
app.use(express.static("static"))
// Forward requests to /client.html
app.get("/", function (req, res) {
	res.sendFile(__dirname + "/client.html")
})

// Initialize database for matches
var matchDB = levelup('./matchDB')


// Counters
var retryAfters = 0

// API REQUEST FUNCTION
// converts a "simple" request to a more precise request for the request library
// TODO: To improve the speed for users, have a separate queue for DB and API requests. Only add requests to the API queue if they are not in DB.
// TODO: In the above case, request all matches in a single batch and only add them to the API request queue if a match is not available.
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
						// TODO: Can improve performance by using "response.body" or whatever it's called - that's already stringified
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
			// TODO: Consider if using retryAfter for this is clean enough, it felt slightly wrong
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

/*
TODO: list of users needs to be split up in FIRST-TIMERS and OLD REQUESTERS
newcommers will be added at the END of the FIRST-TIMERS queue
FIRST-TIMERS will come BEFORE the group of OLD REQUESTERS
TODO: Consider if newcommers should have to wait until OLD REQUESTERS are complete.
Also consider giving OLD REQUESTERS with few requests a slightly higher priority over those with many requests.
This might be obsolete though as those with few requests are completed sooner anyway.
Just make sure that people can not somehow completely block other people by filling up the queue like crazy.
*/
// TODO: Theoretically users might be able to send 10000 single requests and could cause the queue to never start a timeout.
class Queue {
	constructor(/*region for a later version*/) {
		// region for a later version
		// this.region = region
		// array of { socket: socket, pending: [requestOrder1, requestOrder2, ...] } where socket is used as an identifier
		this.users = []
		// timeout working through the queue
		this.timeout
	}
	
	start(timer = 4) { // 1200 for dev key, 3.33333 for standard api key
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
		if (!this.timeout)
			return
		
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
		
		//console.log("u:", u)
		//console.log("this.users:", this.users)
		this.start()
	}
	
	// add request to end of specified socket's list of requestOrders
	append(socket, requestOrder) {
		//console.log("appending request:", requestOrder.url)
		var u = this.users.find(u => u.socket === socket)
		// user exists, add order to end
		if (u)
			u.pending.push(requestOrder)
		// user doesn't exist, add new user to start of queue with order
		else
			this.users.unshift({socket: socket, pending: [requestOrder]})
		
		//console.log("u:", u)
		//console.log("this.users:", this.users)
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
	
	socket.emit("items", items, () => { console.log("player received items") })
	socket.emit("champions", champions, () => { console.log("player received champions") })
	
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
			url: "https://"+data.region+".api.pvp.net/api/lol/"+data.region+"/v1.4/summoner/by-name/"+data.username+"?",
			action: (error, response, summonerData) => {
				if (error || (response && response.statusCode != 200)) {
					// log potential network error
					if (error)
						console.log("REQUEST ERROR for summoner\n", data, "\nerror:\n", error)
					
					// re-queue if error or 429 (retry-after is handled by request)
					if (error || response.statusCode == 429 ||  response.statusCode == 503)
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
					// get requested summoner's id
					var summonerId = summonerData[data.username.toLowerCase().replace(/%20/g, "")].id
					
					// prepare matchlist url
					var matchlistUrl = "https://"+data.region+".api.pvp.net/api/lol/"+data.region+"/v2.2/matchlist/by-summoner/"+summonerId+"?championIds="+(data.championId || "")+"&beginTime="+(data.beginTime || "")+"&endTime="+(data.endTime || "")+"&beginIndex="+(data.beginIndex || 0)+"&endIndex="+(data.endIndex || 100)
					
					queueMatchlist(socket, matchlistUrl, data)
				}
			}
		}
	)
}

// function to call itself for retries
function queueMatchlist(socket, matchlistUrl, data) {
	console.log("adding request for matchlist to queue, data:")
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
					if (error || response.statusCode == 429 ||  response.statusCode == 503)
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
					var matchUrl = "https://"+data.region+".api.pvp.net/api/lol/"+data.region+"/v2.2/match/"+match.matchId+"?includeTimeline=true"
					
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
					if (error || response.statusCode == 429 ||  response.statusCode == 503)
						//!! TODO: Find out how to best handle 503s!
						queueMatch.apply(this, arguments)
					return
				}
			
				//console.log("sending match to user")
				socket.emit("match", body)
			}
		}
	)
}

// GET STATIC DATA FROM RITO ONCE

// TODO: Change item- and champion info's request() to requestQueue

// Item info
var items
function requestItems(url) {
	console.log("Requesting items.")
	request(null, url, (error, response, msg) => {
		if (error || (response && response.statusCode != 200)) {
			console.log("PROBLEM! Couldn't get ITEM data. Retrying.")
			if (error || (response && response.statusCode == 429))
				requestItems(url)
			return
		}
		console.log("Got ITEM data.")
		items = msg.data
	})
}
requestItems("https://global.api.pvp.net/api/lol/static-data/NA/v1.2/item?locale=en_US")

// Champion info
var champions
// TODO: Still needs to be updated every now and then for when new champions are released
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
requestChampion("https://global.api.pvp.net/api/lol/static-data/NA/v1.2/champion?locale=en_US&dataById=true")


process.on("SIGINT", () => {
	console.log("SHUTTING DOWN")
	matchDB.close()
	process.exit()
})


console.log("Server initialization complete.")