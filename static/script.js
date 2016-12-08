"use strict"

// TODO: Hide sorting buttons until progress == max

// TODO: Remember matches between requests so that server doesn't have to send the same matches again on next request. (Server might want to keep recent games in memory too)

// Get HTML elements by ID for use in JS
var form = document.getElementById("form")

var regionInput = document.getElementById("region")
var usernameInput = document.getElementById("username")
var championNameInput = document.getElementById("championName")
var minAgeInput = document.getElementById("minAge")
var maxAgeInput = document.getElementById("maxAge")
var beginIndexInput = document.getElementById("beginIndex")
var endIndexInput = document.getElementById("endIndex")

// Spans used for technical feedback/errors
var userIdSpan = document.getElementById("userId")
var championIdSpan = document.getElementById("championId")
var matchlistInfoSpan = document.getElementById("matchlistInfo")

// Buttons
var submit = document.getElementById("submit")
//var stop = document.getElementById("stop")

// Actual data output
var dataDiv = document.getElementById("data")
var durationSvg = document.getElementById("duration")
var resultDiv = document.getElementById("result")

// Socket initialization
var items
var champions
var socket = io.connect()
socket.once("items", (msg) => { items = msg })
socket.once("champions", (msg) => { champions = msg })
var summoners = {}

var championId
var userId
var username

// TODO: find ACTUAL AUTOCOMPLETION and correction library with dropdown and all that super fancy stuff
// Champion name validation
championNameInput.addEventListener("change", validateChampion)
function validateChampion() {
	var championInputName = championNameInput.value.toLowerCase()
	if (!championInputName) {
		championIdSpan.innerHTML = ""
		championId = null
		return
	}
	
	// Try to find the closest champion name match
	var leastDiffRatio = 1
	var mostSimilarKey
	for (var key in champions) {
		var champion = champions[key]
		
		// Get similarity
		var lev = new Levenshtein(champion.name.toLowerCase(), championInputName)
		var diffRatio = lev.distance / champion.name.length
		
		// Check if more similar than others
		if (diffRatio < leastDiffRatio) {
			leastDiffRatio = diffRatio
			mostSimilarKey = key
			// Perfect match
			if (diffRatio == 0) break
		}
	}
	
	if (leastDiffRatio <= 0.25) {
		championIdSpan.innerHTML = "✔" // check mark for success
		championNameInput.value = champions[mostSimilarKey].name
		championId = champions[mostSimilarKey].id
	} else if (leastDiffRatio <= 0.5) {
		championIdSpan.innerHTML = "❓" // question mark for unsure
		championNameInput.value = champions[mostSimilarKey].name
		championId = champions[mostSimilarKey].id
	} else {
		championIdSpan.innerHTML = "❌" // cross mark for error
	}
}

// Username validation on region/username change
regionInput.addEventListener("change", validateUsername)
usernameInput.addEventListener("change", validateUsername)
function validateUsername() {
	if (!usernameInput.value) {
		socket.off("summoner") // makes sure delayed responses don't overwrite empty innerHTML
		userIdSpan.innerHTML = ""
		userId = null
		username = null
		return
	}
	userIdSpan.innerHTML = "⏳" // hourglass symbol for loading
	userId = null
	username = usernameInput.value
	var region = regionInput.options[regionInput.selectedIndex].text.toLowerCase()
	socket.emit("summoner", {username: username, region: region})
	
	socket.once("summoner", (msg) => {
		if (msg) {
			usernameInput.value = msg[username.toLowerCase().split(" ").join("")].name
			userId = msg[username.toLowerCase().split(" ").join("")].id
			userIdSpan.innerHTML = "✔" // check mark for success
		}
		else userIdSpan.innerHTML = "❌" // cross mark for error
	})
}

// TODO: Auto validate other inputs (game age (max>min>=0 and max>=1) and games (max>min>=0))

form.onsubmit = function() {
	//!! TODO: only allow this request if username is already correct
	// Temporarily disable submit button to prevent submit spam
	submit.disabled = true
	setTimeout(() => submit.disabled = false, 2000)
	
	validateChampion()
	socket.once("summoner", (msg) => {
		if (msg) {
			usernameInput.value = msg[username.toLowerCase().split(" ").join("")].name
			userId = msg[username.toLowerCase().split(" ").join("")].id
			userIdSpan.innerHTML = "✔" // check mark for success
		}
		else
			userIdSpan.innerHTML = "❌" // cross mark for error
	})
	
	// Clear progress and totals only
	dataDiv.innerHTML = ""
	// Remove .column for improved rendering speed
	resultDiv.className = "" // TODO: This is no longer necessary for flexbox display. Only needed when using CSS' column-width and similar
	// prepare values for urls // TODO: region and username could become obsolete
	var region = regionInput.options[regionInput.selectedIndex].text.toLowerCase()
	var username = usernameInput.value
	var minAge = minAgeInput.value
	var maxAge = maxAgeInput.value
	var beginTime
	var endTime
	var beginIndex = beginIndexInput.value
	var endIndex = endIndexInput.value
	var lastDrawn = 0
	var progress = 0
	
	// Sanity check
	if (!region || !username || !beginIndex || beginIndex < 0 || !endIndex || endIndex < 1 || beginIndex >= endIndex) {
		matchlistInfoSpan.innerHTML = "Region and username required. All numbers must be positive. Last game can not be less than or equal the first game."
		return false
	}
	
	// TODO: Consider move champion and item data into some static file so it doesn't need to be sent via socket.
	// championName -> championId
	//if (championName) {
	//	for (var key in champions) {
	//		var champion = champions[key]
	//		if ( champion.name.toLowerCase().split(" ").join("") == championName.toLowerCase().split(" ").join("")
	//			|| champion.key.toLowerCase().split(" ").join("") == championName.toLowerCase().split(" ").join("") ){
	//			championNameInput.value = champion.name
	//			championId = champion.id
	//			break
	//		}
	//	}
	//	TODO: Create dropdown menu with automated filtering on champ name string input
	
	// maxAge -> beginTime
	if (maxAge && maxAge > 0) {
		var d = new Date()
		d.setDate(d.getDate() - maxAge)
		beginTime = d.getTime()
	}
	// minAge -> endTime
	if (minAge && minAge >= 0) {
		var d = new Date()
		d.setDate(d.getDate() - minAge)
		endTime = d.getTime()
	}
	
	// Socket io magic
	// TODO: Consider some "socket.offAll()" or whatever the function is called - pretty sure it already exists
	socket.off("match")
	socket.off("warning")
	
	socket.on("warning", (msg) => { matchlistInfoSpan.innerHTML = msg })
	
	// initialize w/l/r numbers
	var wins = 0
	var losses = 0
	var remakes = 0
	
	class StatCategory {
		constructor(title) {
			this.title = title // eg. "MY ITEMS" or "ENEMY CHAMPIONS" or "ALLIED SUMMONERS"
			// list contains multiple instances of
			// key = {win, loss}
			this.list = {}
		}
		
		increase(key, win) {
			// initialize if key is new
			this.list[key] = this.list[key] || {win: 0, loss: 0}
			// increase win or loss
			if (win) ++this.list[key].win
			else     ++this.list[key].loss
		}
		
		decrease(key, win) {
			if (!this.list[key]) console.log(key)
			// increase win or loss
			if (win) --this.list[key].win
			else     --this.list[key].loss
		}
		
		//!! TODO: Add support for sorting.
		toTable(nameList, minimum) {
			var tbody = ""
			for (var key in this.list) {
				// Skip adding entries with occurences below <minimum> (optional parameter)
				if (this.list[key].win + this.list[key].loss < minimum) continue
				
				var name
				if (nameList && nameList[key]) name = nameList[key].name || nameList[key]
				else name = "N/A: " + key
				tbody += toRow(name,
									this.list[key].win + this.list[key].loss,
									(this.list[key].win || ""),
									(this.list[key].loss || ""))
			}
			if (tbody.length > 0)
				return "<table class='sortable'>" + toHead(this.title) + "<tbody>" + tbody + "</tbody></table>"
			else
				return "<table><thead><tr><th>"+this.title+"</th></tr></thead></table>"
		}
	}

	// DATA
	
	//var playerSummoners = new StatCategory("PLAYER SUMMONER")
	var   allySummoners = new StatCategory("ALLIED<br>SUMMONER")
	var  enemySummoners = new StatCategory("ENEMY<br>SUMMONER")
	
	//champions
	var playerChampions = new StatCategory("PLAYER<br>CHAMPION")
	var   allyChampions = new StatCategory("ALLIED<br>CHAMPION")
	var  enemyChampions = new StatCategory("ENEMY<br>CHAMPION")
	
	//items
	var playerFinalItems = new StatCategory("PLAYER FINAL<br>ITEMS")
	var   allyFinalItems = new StatCategory("ALLIED FINAL<br>ITEMS")
	var  enemyFinalItems = new StatCategory("ENEMY FINAL<br>ITEMS")
	var playerItems = new StatCategory("PLAYER<br>ITEMS")
	var   allyItems = new StatCategory("ALLIED<br>ITEMS")
	var  enemyItems = new StatCategory("ENEMY<br>ITEMS")
	
	//game durations for SVG graph
	var totalWinDuration = 0
	var totalLossDuration = 0
	var longestGame = 0
	
	var    winGameLengths = []
	var   lossGameLengths = []
	var remakeGameLengths = []
	
	// Returns "<tr><td>argument_1</td><td>argument_2</td>...<td>argument_n</td></tr>"
	function toRow() {
		// Start row
		var output = "<tr>"
		// add each argument as a separate column
		for (var i = 0; i < arguments.length; i++) {
			output += "<td><span>" + arguments[i] + "</span></td>"
		}
		// add diff and ratio
		output += "<td>" + (arguments[2] - arguments[3]) + "</td>"
		// TODO: Make it so "2218" gets turned into "2k" and only shows "2218" on :hover
		output += "<td>" + Math.floor(computeRating(arguments[2], arguments[3])*100 + 0.5)/100 + "</td>"
		// End row
		return output + "</tr>"
	}
	
	function toHead(title) {
		return "<thead><tr><th><div>"+title+"</div></th><th><div>Sum</div></th><th><div>Win</div></th><th><div>Loss</div></th><th><div>Diff.</div></th><th title='Have a look at \"Score Calculation\" in the upper left.'><div>Score</div></th></tr></thead>"
	}
	
	function processMatch(matchData) {
		progress++
	
		analyzeMatch(matchData)
		
		// Only draw HTML in a few occasions to reduce load
		//console.log("gonna draw results now, progress:", progress)
		if (Date.now() - lastDrawn > 1500 || progress === max) {
			lastDrawn = Date.now()
			drawResults(matchData)
		}
		if (progress === max) stop()
		// TODO: Simplify calling of all the stuff to do after different steps
	}

	function analyzeMatch(matchData) {
		var playerTeam
		var win
		
		if (!matchData.matchDuration) console.log(matchData)
		var duration = Math.floor(matchData.matchDuration/60 + 0.5)
		
		// Match ended in a /remake before 4:30
		// minor-TODO: check for inhib destruction and ((min 5 tower kills on Summoner's rift) or (min 3 towers on TT))
		if (matchData.matchDuration <= 270) {
			remakes++
			remakeGameLengths[duration] = remakeGameLengths[duration] + 1 || 1
			
			return
		}
		
		// First look for player
		for (var pId in matchData.participants) {
			var p = matchData.participants[pId]
			if (matchData.participantIdentities[pId].player.summonerId == userId) {
				playerTeam = p.teamId
				win = p.stats.winner
				
				playerChampions.increase(p.championId, win)
				
				for (var n = 0; n < 7; n++) {
					if (p.stats["item"+n] >0)
						playerFinalItems.increase(p.stats["item"+n], win)
				}
				
				break
			}
		}
		
		// Analyze timeline data to look for item buy/undo events
		if (matchData.timeline) {
			var frames = matchData.timeline.frames
			for (var frameId in frames) {
				var frame = frames[frameId]
				
				for (var eventId in frame.events) {
					var event = frame.events[eventId]
					var type = event.eventType
					
					// event.participantId begins counting at 1
					// arrays matchData.participants and matchData.participantIdentities begin at 0
					var pId = event.participantId - 1
					
					// If event doesn't have to do with items, skip it
					if (type.indexOf("ITEM") == -1 || pId < 0)
						continue
					
					var participant = matchData.participants[pId]
					var player = matchData.participantIdentities[pId].player
					
					// player
					if (player.summonerId == userId) {
						if (type === "ITEM_PURCHASED") playerItems.increase(event.itemId, win)
						// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
						else if (type === "ITEM_UNDO" && event.itemBefore > 0) playerItems.decrease(event.itemBefore, win)
						
					// enemies
					} else if (participant.teamId != playerTeam) {
						if (type === "ITEM_PURCHASED") enemyItems.increase(event.itemId, win)
						// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
						else if (type === "ITEM_UNDO" && event.itemBefore > 0) enemyItems.decrease(event.itemBefore, win)
						
					// allies
					} else {
						if (type === "ITEM_PURCHASED") allyItems.increase(event.itemId, win)
						// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
						else if (type === "ITEM_UNDO" && event.itemBefore > 0) allyItems.decrease(event.itemBefore, win)
					
					}
				}
			}
		} else {
			// TODO: handle timeline not found; warn the user!!
			console.log("NO TIMELINE DATA FOUND")
		}
		
		// Check stats for enemies and allies (but not the player)
		for (var pId in matchData.participants) {
			// participant
			var participant = matchData.participants[pId]
			// identify the player
			var player = matchData.participantIdentities[pId].player
			
			// skip player
			if (player.summonerId == userId)
				continue
			
			// memorize name linked to id
			if(!summoners[player.summonerId])
				summoners[player.summonerId] = player.summonerName
			
			// enemies
			if (participant.teamId != playerTeam) {
				enemyChampions.increase(participant.championId, win)
				enemySummoners.increase(player.summonerId, win)
				
				for (var n = 0; n < 7; n++) {
					if (participant.stats["item"+n] > 0)
						enemyFinalItems.increase(participant.stats["item"+n], win)
				}

			// allies
			} else {
				allyChampions.increase(participant.championId, win)
				allySummoners.increase(player.summonerId, win)
				
				for (var n = 0; n < 7; n++) {
					if (participant.stats["item"+n] > 0)
						allyFinalItems.increase(participant.stats["item"+n], win)
				}
			}
			// high-TODO: Track W/L for player's skill orders
			// TODO: Track player's kills/deaths to enemy champions
			// TODO: Track champion's red and blue -top/-mid/-bot/-jungle/-supp wins/deaths for super overkill detailed stats
			// TODO: Very advanced - track "comeback items" vs "expand lead items" that lead to win when bought while (far) behind/ahead
			// TODO: Advanced - track "early game" vs "late game" items that lead to a win/loss in 1/3 shortest games vs 1/3 longest games
		}
		
		// Track number of wins/losses and game durations
		longestGame = Math.max(matchData.matchDuration, longestGame)
		if (win) {
			wins++
			totalWinDuration += matchData.matchDuration
			winGameLengths[duration] = winGameLengths[duration] + 1 || 1
		} else {
			losses++
			totalLossDuration += matchData.matchDuration
			lossGameLengths[duration] = lossGameLengths[duration] + 1 || 1
		}
	}
	
	// DRAW CHARTS AND SVG GRAPH
	// TODO: Clean up
	function drawResults(lastMatch) {
		//console.log("DRAWING RESULTS!", progress)
		
		// UPDATE PROGRESS DISPLAY
		var lastMatchCreation = new Date(lastMatch.matchCreation)
		
		var outputProgress = "<div id=progress class=mouseover><strong>Progress:</strong> "+progress+" / "+max+"<br><progress value="+progress+" max="+max+"></progress>"+
								"<div class='more'><a href='"+matchlistUrl+"'>Matchlist</a> (requires API key)<br>"+
								"Last match analyzed: ID: "+lastMatch.matchId+"<br>Date: "+lastMatchCreation.toString()+"</div>"+
								"</div><button id=stop onclick=stop()>Stop</button>"
								// TODO: Don't draw stop button and progress completely new, instead use display: none; for Results
								// TODO: get timestamps of 1st and last match in matchlist to provide info about their dates (timeframe of stats)
		
		// TODO: Add small item/champion ICONS to the left side of item/champion names
		
		var outputTotalsTable = "<table><thead><tr><th></th><th>Sum</th><th>Win</th><th>Loss</th><th>Remake</th></tr></thead><tbody><tr><td>Games</td><td>"+(wins+losses)+"</td><td>"+wins+"</td><td>"+losses+"</td><td>"+remakes+"</td></tr></tbody></table>"
		
		// Draw progress info
		dataDiv.innerHTML = outputProgress + outputTotalsTable
	
		// UPDATE ACTUAL RESULT DISPLAY
		
		// Draw game duration SVG graph
		var maxLength = Math.max(winGameLengths.length, lossGameLengths.length)
		var mostGames = 0
		// TODO: Maybe add mouseovers to game-blocks/bars that show exact times and number of games
		var svgCode = ""
		for (var i = 0; i < maxLength; i++) {
			var w = winGameLengths[i] || 0
			var l = lossGameLengths[i] || 0
			mostGames = Math.max(w, l, mostGames)
		}
		// Background lines/dots
		for (var i = 1; i < 30+1; i++) {
			if (i%10 == 0) {
				svgCode += "<line x1=5 x2=900 y1="+i*10+" y2="+i*10+" stroke=#444 stroke-dasharray='90, 10' />"
				svgCode += "<text x=900 y="+i*10+" fill=#888 text-anchor=end dominant-baseline=text-after-edge>"+(30-i)+" games</text>"
			}
			else if (i%5 == 0) svgCode += "<line x1=5 x2=900 y1="+i*10+" y2="+i*10+" stroke=#444 stroke-dasharray='40, 10' />"
			else svgCode += "<line x1=4 x2=900 y1="+i*10+" y2="+i*10+" stroke=#555 stroke-dasharray='2, 8' />"
		}
		
		// Actual graph
		for (var i = 0; i < 90; i++) {
			var w = winGameLengths[i] || 0
			var l = lossGameLengths[i] || 0
			var r = remakeGameLengths[i] || 0
			// Draw wins and losses
			if (w > 0) svgCode += "<line x1="+i*10+" x2="+i*10+" y1=299.5 y2="+(300-w*10)+" stroke-width=6 stroke=#0f0 stroke-dasharray='9, 1' />"
			if (l > 0) svgCode += "<line x1="+i*10+" x2="+i*10+" y1=299.5 y2="+(300-l*10)+" stroke-width=6 stroke=#f00 stroke-dasharray='9, 1' />"
			if (r > 0) svgCode += "<line x1="+i*10+" x2="+i*10+" y1=299.5 y2="+(300-r*10)+" stroke-width=6 stroke=#888 stroke-dasharray='9, 1' />"
			// 0m, 10m, 20m, ... timestamps and 3m /remake marker
			if (i%10 == 0 || i == 3) svgCode += "<text x="+i*10+" y=0 fill=#888 dominant-baseline=hanging>"+i+"m</text>"
		}
		
		//3m line
		svgCode += "<line x1="+3*10+" x2="+3*10+" y1=5 y2=400 stroke=#444 stroke-dasharray='40, 10' />"
		//20m line
		svgCode += "<line x1="+20*10+" x2="+20*10+" y1=5 y2=400 stroke=#444 stroke-dasharray='40, 10' />"

		// TODO: Add back mouseover text to numbers, use visibility: hidden/visible for improved performance
		
		var avgWinDuration = totalWinDuration/wins/60
		var avgLossDuration = totalLossDuration/losses/60
		
		// Used to make sure average win and loss duration texts don't overlap unless equal
		var avgWinTextAlign = ""
		var avgLossTextAlign = ""
		if (avgWinDuration && avgLossDuration) {
			if (avgWinDuration > avgLossDuration) {
				avgLossTextAlign = "text-anchor=end"
			} else if (avgWinDuration < avgLossDuration) {
				avgWinTextAlign = "text-anchor=end"
			}
		}
		// Legend
		svgCode += "<g>"+
		"<rect x=5 y=18 fill=#0f0 width=6 height=9 />"+
		"<text x=15 y=15 fill=#0f0 dominant-baseline=hanging>Win</text>"+
		"<rect x=5 y=33 fill=#ff0 width=6 height=9 />"+
		"<text x=15 y=30 fill=#ff0 dominant-baseline=hanging>Win&Loss</text>"+
		"<rect x=5 y=48 fill=#f00 width=6 height=9 />"+
		"<text x=15 y=45 fill=#f00 dominant-baseline=hanging>Loss</text>"+
		"<rect x=5 y=63 fill=#888 width=6 height=9 />"+
		"<text x=15 y=60 fill=#888 dominant-baseline=hanging>Remake</text>"+
		"</g>"
			
		// Average win
		if (avgWinDuration) {
			svgCode += "<g>"+
			"<line x1="+avgWinDuration*10+" x2="+avgWinDuration*10+" y1=5 y2=400 stroke=#0f0 stroke-dasharray='40, 10' />"+
			"<text x="+avgWinDuration*10+" y=20 "+avgWinTextAlign+" fill=#0f0 dominant-baseline=hanging>average</text>"+
			"<text x="+avgWinDuration*10+" y=35 "+avgWinTextAlign+" fill=#0f0 dominant-baseline=hanging>"+Math.floor(avgWinDuration*100+0.5)/100+"m</text>"+
			"</g>"
		}
		// Average loss
		if (avgLossDuration) {
			svgCode += "<g>"+
			"<line x1="+avgLossDuration*10+" x2="+avgLossDuration*10+" y1=5 y2=400 stroke=#f00 stroke-dasharray='40, 10' />"+
			"<text x="+avgLossDuration*10+" y=20 "+avgLossTextAlign+" fill=#f00 dominant-baseline=hanging>average</text>"+
			"<text x="+avgLossDuration*10+" y=35 "+avgLossTextAlign+" fill=#f00 dominant-baseline=hanging>"+Math.floor(avgLossDuration*100+0.5)/100+"m</text>"+
			"</g>"
		}
		// Longest game
		svgCode += "<g>"+
		"<line x1="+longestGame/60*10+" x2="+longestGame/60*10+" y1=5 y2=400 stroke=#00f stroke-dasharray='40, 10' />"+
		"<text x="+longestGame/60*10+" y=50 fill=#00f dominant-baseline=hanging>longest</text>"+
		"<text x="+longestGame/60*10+" y=65 fill=#00f dominant-baseline=hanging>"+Math.floor(longestGame/60*100+0.5)/100+"m</text>"+
		"</g>"
		
		//!! TODO: Make SVG viewbox automatically scale up/down based on the longest game and highest number of matches
		//highestLine =
		//durationSvg.setAttribute("viewBox", "0 0 " + (maxLength + 3)/60*10 + " " + (highestLine + 3)*10)
		durationSvg.innerHTML = svgCode
		
		// Hide some rarely occuring players/items/champs to reduce clutter when many games were analyzed
		var minSum = Math.ceil(Math.log10(wins+losses))
		
		// TODO: Make 2nd parameters depend on table's length instead of wins+losses; let users get all available info on demand
		resultDiv.innerHTML = "<div>"+
									 playerChampions.toTable(champions, minSum)+
									 allySummoners.toTable  (summoners, minSum)+
									 enemySummoners.toTable (summoners, minSum)+
									 "</div>"+
									 allyChampions.toTable  (champions, minSum)+
									 enemyChampions.toTable (champions, minSum)+
									 playerItems.toTable(items, minSum)+
									 allyItems.toTable  (items, minSum)+
									 enemyItems.toTable (items, minSum)
									 
		// playerFinalItems.toTable(items,2)
		// allyFinalItems.toTable  (items,2)
		// enemyFinalItems.toTable (items,2)
	}
	
	
	// MATCHLIST
	var matchlist
	var matchlistUrl
	var max
	// Handle received matchlist
	socket.once("matchlist", (msg) => {
		matchlist = msg.matchlist
		matchlistUrl = msg.matchlistUrl
		max = msg.matchlist.endIndex - msg.matchlist.startIndex
		if (max > 0) matchlistInfoSpan.innerHTML = "matchlist acquired"
		else matchlistInfoSpan.innerHTML = "matchlist empty"
	})
	
	socket.on("match", processMatch)
	// TODO: Add/show stop button here
	// TODO: Ensure client has sufficient data before creating request for server
	// request from server
	matchlistInfoSpan.innerHTML = "requesting matchlist..."
	var requestObject = compact({
		region: region,
		username: username,
		championId: championId,
		beginIndex: beginIndex,
		endIndex: endIndex,
		beginTime: beginTime,
		endTime: endTime
	})
	socket.emit("request", requestObject)
	console.log(requestObject)
	
	return false
}

function computeRating(wins, losses) {
	//return (wins+1)/(losses+1)
	
	//var difference = wins - losses
	//var rating = difference
	//if      (difference > 0) rating = rating*(wins  /(wins+losses))
	//else if (difference < 0) rating = rating*(losses/(wins+losses))
	//return rating
	
	//return (wins + 1)/(losses + 2)
	
	// This formula looks fine for numbers far away from 0.
	// Need to make sure it also looks fine for numbers close to 0.
	if      (wins > losses) return  (wins+1)/(losses+2)
	else if (wins < losses) return -(losses+1)/(wins+2)
	else                    return 0
	// low-TODO: Score probably still not perfect. For players who have an extremely high winrate and thus buy many more items in wins than in losses, score will always be a positive number, even if win rates for said items are way below average. This might not actually be a problem though.
}

// TODO: Figure out why this function must be defined outside the onclick
function stop() {
	console.log("stopping")
	socket.emit("stop")
	sorttable.init()
	// Add class to render tables in columns
	//resultDiv.className = "column"
	// TODO: Make button not dis-/reappear in DOM. Instead show/hide via CSS.
	document.getElementById("stop").remove()
}

// takes an object and removes values of null and undefined
// eg. object{honk: true, foo: null} -> object{honk: true}
function compact(obj) {
	for (var key in obj) {
		if (obj[key] == null) delete obj[key]
	}
	return obj
}