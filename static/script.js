"use strict"

// TODO: If a monster was slain by killerId = 0, then look for a Shaco player and credit them. If there was no Shaco player, log the match server side.
// TODO: Let users select ranked queues

// TODO: Put filter buttons into a mouseover-expandable menu above each table
// TODO: Turn belowMinimum into a toggle-able filter

// TODO: Show LOADING animation while script is running.

// TODO: Offer table with actual matchlist. (optional: let users filter matches by champion/item occurance)
// But also make summoner names (and maybe player-champions) clickable. Clicking them inserts their values into the appropriate input fields so that a user can then search with these parameters.

// TODO: Add support for search parameters in url
// TODO: Show more player stats. Division, etc.
// TODO: Redo how tables are drawn. Merge tablesort into the system.
// TODO: Improve sorting performance for massive (2000+) lists.
// TODO: Redo "click to reveal": Don't hide items if only 1-4 would be hidden in the first place.
// TODO: Remember matches between requests so that server doesn't have to send the same matches again on next request. (Server might want to keep recent games in memory too)

// Track these statistics:
// TODO: Track picks and bans
// TODO: Track keystones (and maybe other masteries)
// TODO: Track summoner spells
// TODO: Track player's kills/deaths to enemy champions
// TODO: Track champion's red and blue -top/-mid/-bot/-jungle/-supp wins/deaths for super overkill detailed stats (so basically 10 slots per champion - maybe show on mouseover?)
// TODO: Advanced - track W/L for player's skill orders
// TODO: Advanced - track "early game" vs "late game" items that lead to a win/loss in 1/3 shortest games vs 1/3 longest games
// TODO: Very advanced - track "comeback items" vs "expand lead items" that lead to win when bought while (far) behind/ahead
// TODO: Make objectives and other things per-side, eg. killing bot inhib as blue side might have a different importance than killing bot inhib as red side due to map asymmetry


// Platform IDs taken from https://developer.riotgames.com/docs/regional-endpoints
var platforms = {
	br:  "BR1",
	eune:"EUN1",
	euw: "EUW1",
	jp:  "JP1",
	kr:  "KR",
	lan: "LA1",
	las: "LA2",
	na:  "NA1",
	oce: "OC1",
	tr:  "TR1",
	ru:  "RU",
	pbe: "PBE1"
}

var objectives = {
	BARON_NASHOR: "Baron Nashor",
	ELDER_DRAGON: "Elder Dragon",
	RIFTHERALD:   "Rift Herald",
	VILEMAW:      "Vilemaw",
	
	// Elemental dragons
	AIR_DRAGON:   "Cloud Drake",
	EARTH_DRAGON: "Mountain Drake",
	FIRE_DRAGON:  "Infernal Drake",
	WATER_DRAGON: "Ocean Drake",
	
	// Removed
	DRAGON:       "Dragon (old)",
	
	// Buildings
	OUTER_TURRET:       "Outer turret",
	INNER_TURRET:       "Inner turret",
	BASE_TURRET:        "Base turret",
	INHIBITOR_BUILDING: "Inhibitor",
	NEXUS_TURRET:       "Nexus turret",
	
	// First objectives
	firstBlood:     "First blood",
	firstTower:     "First tower",
	firstInhibitor: "First inhibitor",
	firstBaron:     "First baron",
	firstDragon:    "First dragon",
}


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
var dataDiv = document.getElementById("data") // contains progress, summaries and similar
var durationSvg = document.getElementById("duration") // contains game length graph
var resultDiv = document.getElementById("result") // contains allied/enemy/player champions/items, etc.

// Socket initialization
var latestVersion
var champions
var items
var socket = io.connect()
socket.once("latestVersion", (msg) => { latestVersion = msg })
socket.once("champions", (msg) => { champions = msg })
socket.once("items", (msg) => { items = msg })
var summoners = {}

var championId
var user
var username

// TODO: find ACTUAL AUTOCOMPLETION and correction library with dropdown and all that super fancy stuff
// Champion name validation
championNameInput.addEventListener("change", validateChampion)
function validateChampion() {
	var championInputName = championNameInput.value.toLowerCase()
	
	if (!championInputName) {
		championIdSpan.innerHTML = ""
		championId = null
		championNameInput.style.backgroundImage = ""
		return
	}
	
	// Try to find the closest champion name match
	var leastDiffRatio = 1
	var mostSimilarId
	for (var id in champions) {
		var champion = champions[id]
		
		// Get similarity
		var lev = new Levenshtein(champion.name.toLowerCase(), championInputName)
		var diffRatio = lev.distance / champion.name.length
		
		// Check if more similar than others
		if (diffRatio < leastDiffRatio) {
			leastDiffRatio = diffRatio
			mostSimilarId = id
			// Perfect match
			if (diffRatio == 0) break
		}
	}
	
	if (leastDiffRatio <= 0.5) {
		if (leastDiffRatio <= 0.25)
			championIdSpan.innerHTML = "✔" // check mark for success
		else
			championIdSpan.innerHTML = "❓" // question mark for unsure
		championNameInput.value = champions[mostSimilarId].name
		championId = champions[mostSimilarId].id
		championNameInput.style.backgroundImage = "url(https://ddragon.leagueoflegends.com/cdn/"+latestVersion+"/img/champion/"+champions[mostSimilarId].key+".png)"
	} else {
		championIdSpan.innerHTML = "❌" // cross mark for error
		championId = null
		championNameInput.style.backgroundImage = ""
	}
}

// Username validation on region/username change
regionInput.addEventListener("change", validateUsername)
usernameInput.addEventListener("change", validateUsername)
function validateUsername() {
		userIdSpan.innerHTML = ""
		user = null
		usernameInput.style.backgroundImage = ""
		
	if (!usernameInput.value) {
		socket.off("summoner") // makes sure delayed responses don't overwrite empty innerHTML
		return
	}
	
	userIdSpan.innerHTML = "⏳" // hourglass symbol for loading
	
	socket.emit("summoner", {
		username: usernameInput.value,
		region: regionInput[regionInput.selectedIndex].value
	})
	expectSummonerMessage()
}

function expectSummonerMessage() {
	socket.once("summoner", (data) => {
		if (data) {
			user = data
			usernameInput.value = user.name
			userIdSpan.innerHTML = "✔" // check mark for success
			usernameInput.style.backgroundImage = "url(https://ddragon.leagueoflegends.com/cdn/"+latestVersion+"/img/profileicon/"+user.profileIconId+".png)"
		}
		else userIdSpan.innerHTML = "❌" // cross mark for error
	})
}

// TODO: Auto validate other inputs (game age (max>min>=0 and max>=1) and games (max>min>=0))

form.onsubmit = function() {
	
	// Temporarily disable submit button to prevent submit spam
	submit.disabled = true
	setTimeout(() => submit.disabled = false, 2000)
	
	validateChampion()
	expectSummonerMessage()
	
	// Clear progress and totals only
	dataDiv.innerHTML = ""
	// Remove .column for improved rendering speed
	resultDiv.className = "" // TODO: This is no longer necessary for flexbox display. Only needed when using CSS' column-width and similar
	// prepare values for urls // TODO: region and username could become obsolete
	var region = regionInput[regionInput.selectedIndex].value
	var username = usernameInput.value
	var minAge = minAgeInput.value
	var maxAge = maxAgeInput.value
	var beginTime
	var endTime
	var beginIndex = parseInt(beginIndexInput.value) || 0
	beginIndexInput.value = beginIndex
	var endIndex = parseInt(endIndexInput.value) || 100
	endIndexInput.value = endIndex
	var lastDrawn = 0
	var progress = 0
	
	// Sanity check
	if (!region || !username || beginIndex < 0 || endIndex < 1 || beginIndex >= endIndex) {
		matchlistInfoSpan.innerHTML = "Region and username required. Numbers must not be negative. Last game can not be less than or equal the first game."
		return false
	}
	
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
	
	// Socket io
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
		
		//! TODO: Add support for sorting.
		toTable(id, nameList, minimum = 1) {
			var filters = ""
			var tbodyContent = ""
			var tfoot = ""
			// Variable used to verify if anything will be hidden at all
			var itemsBelowMinimum = 0
			
			for (var key in this.list) {
				var classAttribute
				// Check for occurences below <minimum> (optional parameter)
				if (this.list[key].win + this.list[key].loss < minimum) {
					itemsBelowMinimum++
					classAttribute = "belowMinimum "
				}
				else
					classAttribute = ""
				
				// Prepare variables for table
				var win = (this.list[key].win || "")
				var loss = (this.list[key].loss || "")
				var name
				if (nameList && nameList[key]) name = nameList[key].name || nameList[key]
				else name = "N/A: " + key
				
				// Special case for enchanted jungler items. These names only contain the enchantment name, they are missing the actual jungle item that was enchanted. Here I add the actual item name before the enchantment. The actual item name is gained via the id of the last (hopefully that wont change) entry in the "from" array.
				if (name.includes("Enchantment"))
					name = nameList[nameList[key].from[nameList[key].from.length - 1]].name + " " + name
				
				if (!nameList[key])
					console.log(key, "not in namelist")
				// Prepare classes for filters
				if (nameList && nameList[key] && nameList[key].into)
					classAttribute += "filter-into "
				if (nameList && nameList[key] && nameList[key].from)
					classAttribute += "filter-from "
				
				tbodyContent += "<tr class='" + classAttribute + "'>"
				/* Name   */  + '<td class=statName title="' + name + '"><span>' + name + "</span></td>"
				/* Sum    */  + "<td class=statNumber><span>" + (win+loss) + "</span></td>"
				/* Wins   */  + "<td class=statNumber><span>" + win + "</span></td>"
				/* Losses */  + "<td class=statNumber><span>" + loss + "</span></td>"
				/* Diff   */  + "<td class=statNumber><span>" + (win-loss) + "</span></td>"
				/* Score  */  + "<td class=statNumber><span>" + Math.floor(computeRating(win, loss)*100 + 0.5)/100 + "</span></td>"
				              + "</tr>"
			}
			
			if (id && id.includes("items")) {
				filters += "<label><input type=checkbox class=filter data-filter=filter-only-completed data-target='"+id+"' disabled>Only completed items</label>"
			}
			
			if (tbodyContent.length > 0 || itemsBelowMinimum) { // low-TODO: There can be very special cases in which all content is hidden. Is that okay?
				if (itemsBelowMinimum)
					tfoot += "<tfoot onclick=reveal(this)><tr><td class=revealButton colspan=6 title='rows were hidden because their occurance was below " + minimum + "'>" + itemsBelowMinimum + " rows hidden - click to reveal</td></tr></tfoot>"
				return "<div class=statCategory id='"+id+"'><div class=filterList>" + filters + "</div><table class=notYetSortable>" + toHead(this.title) + "<tbody>" + tbodyContent + "</tbody>" + tfoot + "</table></div>"
			} else
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
	/*var playerFinalItems = new StatCategory("PLAYER FINAL<br>ITEMS")
	var   allyFinalItems = new StatCategory("ALLIED FINAL<br>ITEMS")
	var  enemyFinalItems = new StatCategory("ENEMY FINAL<br>ITEMS")*/
	var playerItems = new StatCategory("PLAYER<br>ITEMS")
	var   allyItems = new StatCategory("ALLIED<br>ITEMS")
	var  enemyItems = new StatCategory("ENEMY<br>ITEMS")
	
	var  allyObjectives = new StatCategory("ALLIED<br>KILLS")
	var enemyObjectives = new StatCategory("ENEMY<br>KILLS")
	
	//game durations for SVG graph
	var totalWinDuration = 0
	var totalLossDuration = 0
	var longestGame = 0
	
	var    winGameLengths = []
	var   lossGameLengths = []
	var remakeGameLengths = []
	
	//extra stats
	var totalKills = 0
	var totalDeaths = 0
	var totalAssists = 0
	
	var bestKDA = 0
	var bestKDAgameId
	var bestKDAstats
	
	function toHead(title) {
		return "<thead><tr><th><div>"+title+"</div></th><th><div class=rotated>Sum</div></th><th><div class=rotated>Win</div></th><th><div class=rotated>Loss</div></th><th><div class=rotated>Diff.</div></th><th title='Have a look at \"Score Calculation\" in the upper left.'><div class=rotated>Score</div></th></tr></thead>"
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
		if (progress === max) {
			matchlistInfoSpan.innerHTML = "Done!"
			stop()
		}
		// TODO: Simplify calling of all the stuff to do after different steps
	}

	function analyzeMatch(matchData) {
		var playerTeam
		var win
		
		if (!matchData.gameDuration) console.log(matchData)
		var duration = Math.floor(matchData.gameDuration/60 + 0.5)
		
		// Match ended in a /remake before 4:30
		// minor-TODO: check for inhib destruction and ((min 5 tower kills on Summoner's rift) or (min 3 towers on TT))
		if (matchData.gameDuration <= 270) {
			remakes++
			remakeGameLengths[duration] = remakeGameLengths[duration] + 1 || 1
			
			return
		}
		
		// First look for player
		for (var pId in matchData.participants) {
			var p = matchData.participants[pId]
			if (matchData.participantIdentities[pId].player.summonerId == user.id) {
				playerTeam = p.teamId
				win = p.stats.win
				
				// find best KDA
				var tempKDA = (p.stats.kills + p.stats.assists) / Math.max(0.75, p.stats.deaths)
				if (tempKDA > bestKDA) {
					bestKDA = tempKDA
					bestKDAgameId = matchData.gameId
					bestKDAstats = p.stats.kills+"/"+p.stats.deaths+"/"+p.stats.assists
				}
				
				// total KDA
				totalKills += p.stats.kills
				totalDeaths += p.stats.deaths
				totalAssists += p.stats.assists
				
				playerChampions.increase(p.championId, win)
				
				/*for (var n = 0; n < 7; n++) {
					if (p.stats["item"+n] >0)
						playerFinalItems.increase(p.stats["item"+n], win)
				}*/
				
				break
			}
		}
		
		// Analyze team data for firstBlood, firstTower, firstInhibitor, firstBaron, firstDragon
		for (var teamKey in matchData.teams) {
			var team = matchData.teams[teamKey]
			// Only iterate through specific keys of team object
			for (var objectiveKey in (({ firstBlood, firstTower, firstInhibitor, firstBaron, firstDragon }) => ({ firstBlood, firstTower, firstInhibitor, firstBaron, firstDragon }))(team)) {
				var objective = team[objectiveKey]
				if (objective) {
					if (team.teamId === playerTeam)
						allyObjectives.increase(objectiveKey, win)
					else
						enemyObjectives.increase(objectiveKey, win)
				}
			}
		}
		
		
		// Analyze timeline data to look for item buy/undo events
		if (matchData.timeline) {
			var frames = matchData.timeline.frames
			for (var frameId in frames) {
				var frame = frames[frameId]
				
				for (var eventId in frame.events) {
					var event = frame.events[eventId]
					var eventType = event.eventType
					
					// event.participantId begins counting at 1
					// arrays matchData.participants and matchData.participantIdentities begin at 0
					var pId = event.participantId - 1
					
					// If event doesn't have to do with items, skip it
					if (eventType.indexOf("ITEM") != -1 && pId >= 0) {
						var participant = matchData.participants[pId]
						var player = matchData.participantIdentities[pId].player
						
						// TODO: Check for ITEM_DESTROYED of Archangel's Staff, Manamune (and more?) to find out when Seraph's Embrace, Muramana, etc. were created
							
						// player
						if (player.summonerId == user.id) {
							if (eventType === "ITEM_PURCHASED") playerItems.increase(event.itemId, win)
							// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
							else if (eventType === "ITEM_UNDO" && event.itemBefore > 0) playerItems.decrease(event.itemBefore, win)
							
						// enemies
						} else if (participant.teamId != playerTeam) {
							if (eventType === "ITEM_PURCHASED") enemyItems.increase(event.itemId, win)
							// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
							else if (eventType === "ITEM_UNDO" && event.itemBefore > 0) enemyItems.decrease(event.itemBefore, win)
							
						// allies
						} else {
							if (eventType === "ITEM_PURCHASED") allyItems.increase(event.itemId, win)
							// decrease item on mispurchase, ignore itemBefore with id 0 (which happens when undoing a sell)
							else if (eventType === "ITEM_UNDO" && event.itemBefore > 0) allyItems.decrease(event.itemBefore, win)
						
						}
					}
					// Count monsters killed (including CS and jungles?)
					else if (eventType === ("ELITE_MONSTER_KILL")) {
						if (event.killerId == 0) {
							console.log("Error: killerId equals 0. Skipping monster kill. gameId: " + matchData.gameId)
							continue
						}
						
						if (event.monsterSubType)
							var monster = event.monsterSubType
						else
							var monster = event.monsterType
						
						if (matchData.participants[event.killerId-1].teamId == playerTeam) allyObjectives.increase(monster, win)
						else enemyObjectives.increase(monster, win)
					}
					else if (eventType == ("BUILDING_KILL")) {
						if (event.buildingType === "TOWER_BUILDING")
							var building = event.towerType
						else if (event.buildingType === "INHIBITOR_BUILDING")
							var building = event.buildingType
						
						if (event.teamId != playerTeam) allyObjectives.increase(building, win)
						else enemyObjectives.increase(building, win)
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
			if (player.summonerId == user.id)
				continue
			
			// memorize name linked to id
			if(!summoners[player.summonerId])
				summoners[player.summonerId] = player.summonerName
			
			// enemies
			if (participant.teamId != playerTeam) {
				enemyChampions.increase(participant.championId, win)
				enemySummoners.increase(player.summonerId, win)
				
				/*for (var n = 0; n < 7; n++) {
					if (participant.stats["item"+n] > 0)
						enemyFinalItems.increase(participant.stats["item"+n], win)
				}*/

			// allies
			} else {
				allyChampions.increase(participant.championId, win)
				allySummoners.increase(player.summonerId, win)
				
				/*for (var n = 0; n < 7; n++) {
					if (participant.stats["item"+n] > 0)
						allyFinalItems.increase(participant.stats["item"+n], win)
				}*/
			}
		}
		
		// Track number of wins/losses and game durations
		longestGame = Math.max(matchData.gameDuration, longestGame)
		if (win) {
			wins++
			totalWinDuration += matchData.gameDuration
			winGameLengths[duration] = winGameLengths[duration] + 1 || 1
		} else {
			losses++
			totalLossDuration += matchData.gameDuration
			lossGameLengths[duration] = lossGameLengths[duration] + 1 || 1
		}
	}
	
	// DRAW CHARTS AND SVG GRAPH
	// TODO: Clean up
	function drawResults(lastMatch) {
		//console.log("DRAWING RESULTS!", progress)
		
		// UPDATE PROGRESS DISPLAY
		var lastgameCreation = new Date(lastMatch.gameCreation)
		
		var outputProgress = "<div id=progress class=mouseover><strong>Progress:</strong> "+progress+" / "+max+"<br><progress value="+progress+" max="+max+"></progress>"+
								"<div class='more'><a href='"+matchlistUrl+"'>Matchlist</a> (requires API key)<br>"+
								"Last match analyzed: ID: "+lastMatch.gameId+"<br>Date: "+lastgameCreation.toString()+"</div>"+
								"</div><button id=stop onclick=stop()>Stop</button>"
								// TODO: Don't draw stop button and progress completely new, instead use display: none; for Results
								// TODO: get timestamps of 1st and last match in matchlist to provide info about their dates (timeframe of stats)
		
		// TODO: Add small item/champion ICONS to the left side of item/champion names
		
		var outputTotalsTable = "<table><thead><tr><th></th><th>Sum</th><th>Win</th><th>Loss</th><th>Remake</th></tr></thead><tbody><tr><td>Games</td><td>"+(wins+losses)+"</td><td>"+wins+"</td><td>"+losses+"</td><td>"+remakes+"</td></tr></tbody></table>"
		
		var otherStats = "<span>Average KDA</span>: "+(Math.ceil(totalKills/progress*100)/100)+"/"+(Math.ceil(totalDeaths/progress*100)/100)+"/"+(Math.ceil(totalAssists/progress*100)/100)+"</span><br>"+
			"<span title='( Kills + Assists ) / ( Deaths ), where Deaths of 0 are replaced by 0.75'>Best KDA</span>: "+bestKDAstats+
			" (<a href=http://matchhistory."+region+".leagueoflegends.com/en/#match-details/"+platforms[region]+"/"+bestKDAgameId+">match</a>)"
		
		// Draw progress info
		dataDiv.innerHTML = outputProgress + outputTotalsTable + otherStats
	
		// UPDATE ACTUAL RESULT DISPLAY
		
		// Draw game duration SVG graph
		// Add some blank space to the right side
		var maxTime = Math.max(27.5, longestGame/60 + 5) // minimum time of 27.5m to fit legend
		var maxGames = 0
		
		// mostGames used to find out highest bar
		// TODO: Replace maxLength and loop with two separate loops for winGameLengths and lossGameLengths
		var maxLength = Math.max(winGameLengths.length, lossGameLengths.length)
		// TODO: Maybe add mouseovers to game-blocks/bars that show exact times and number of games
		
		for (var i = 0; i < maxLength; i++) {
			var w = winGameLengths[i] || 0
			var l = lossGameLengths[i] || 0
			var r = remakeGameLengths[i] || 0
			maxGames = Math.max(w, l, r, maxGames)
		}
		maxGames += 3 // Add some blank space above
		// TODO: replace y height stuff
		
		// Initialize SVG code
		var svgCode = "<text x=0 y=0 fill=#444 font-size=2em dominant-baseline=hanging>Game durations</text>"
		
		// Horizontal background lines
		for (var i = 1; i <= maxGames; i++) {
			// labels for Y-axis
			if ((maxGames-i)%5 == 0)
				svgCode += "<text x=0 y="+i*10+" fill=#888 text-anchor=end dominant-baseline=middle>"+(maxGames-i)+" games</text>"
			// alternating stroke dasharray
			if ((maxGames-i)%10 == 0)
				svgCode += "<line x1=5 x2=" + maxTime*10 + " y1="+i*10+" y2="+i*10+" stroke=#444 stroke-dasharray='90, 10' />"
			else if ((maxGames-i)%5 == 0)
				svgCode += "<line x1=5 x2=" + maxTime*10 + " y1="+i*10+" y2="+i*10+" stroke=#444 stroke-dasharray='40, 10' />"
			//else svgCode += "<line x1=4 x2=" + maxTime*10 + " y1="+i*10+" y2="+i*10+" stroke=#555 stroke-dasharray='2, 8' />"
		}
		
		// Vertical lines
		for (var i = 0; i < maxTime; i++) { //! TODO: Handle "games" counts //??
			var w = winGameLengths[i] || 0
			var l = lossGameLengths[i] || 0
			var both = Math.min(w, l)
			var r = remakeGameLengths[i] || 0
			// Yellow lines
			if (both > 0) svgCode += "<line x1="+i*10+" x2="+i*10+" y1="+(maxGames*10-0.5)+" y2="+((maxGames-both)*10)+" stroke-width=6 stroke=#ff0 stroke-dasharray='9, 1' />"
			// Green lines for wins > losses
			if (w > both) svgCode += "<line x1="+i*10+" x2="+i*10+" y1="+((maxGames-both)*10-0.5)+" y2="+((maxGames-w)*10)+" stroke-width=6 stroke=#0f0 stroke-dasharray='9, 1' />"
			// Red lines for losses > wins
			if (l > both) svgCode += "<line x1="+i*10+" x2="+i*10+" y1="+((maxGames-both)*10-0.5)+" y2="+((maxGames-l)*10)+" stroke-width=6 stroke=#f00 stroke-dasharray='9, 1' />"
			// Grey lines for remakes
			if (r > 0) svgCode += "<line x1="+i*10+" x2="+i*10+" y1="+(maxGames*10-0.5)+" y2="+(maxGames*10-r*10)+" stroke-width=6 stroke=#888 stroke-dasharray='9, 1' />"
			// 0m, 10m, 20m, ... timestamps and 3m /remake marker
			if (i == 3 || i == 15 || (i%10 == 0 && i+2 < maxTime))
				svgCode += "<text x="+i*10+" y="+(maxGames*10+5)+" fill=#888 text-anchor=middle dominant-baseline=hanging>"+i+"m</text>"
		}
		
		// 3m, 15m, 20m lines
		for (let i of [3, 15, 20]) {
			svgCode += "<line x1="+i*10+" x2="+i*10+" y1="+(maxGames-0.5)*10+" y2=5 stroke=#444 stroke-dasharray='40, 10' />"
		}

		// TODO: Add back mouseover text to numbers, use visibility: hidden/visible for improved performance
		
		var avgWinDuration = totalWinDuration/wins/60
		var avgLossDuration = totalLossDuration/losses/60
		
		// Used to make sure average win and loss duration texts don't overlap unless equal
		var avgWinTextAlign = "text-anchor=end"
		var avgLossTextAlign = "text-anchor=end"
		if (avgWinDuration && avgLossDuration) {
			if (avgWinDuration > avgLossDuration)
				avgWinTextAlign = "text-anchor=start"
			else if (avgWinDuration < avgLossDuration)
				avgLossTextAlign = "text-anchor=start"
		}
			
		// Average win
		if (avgWinDuration) {
			svgCode +=
			"<line x1="+avgWinDuration*10+" x2="+avgWinDuration*10+" y1="+(maxGames-0.5)*10+" y2=5 stroke=#0f0 stroke-dasharray='40, 10' />"+
			"<text x="+avgWinDuration*10+" y=5 "+avgWinTextAlign+" fill=#0f0 dominant-baseline=hanging>avg. "+Math.floor(avgWinDuration*100+0.5)/100+"m</text>"
		}
		// Average loss
		if (avgLossDuration) {
			svgCode +=
			"<line x1="+avgLossDuration*10+" x2="+avgLossDuration*10+" y1="+(maxGames-0.5)*10+" y2=5 stroke=#f00 stroke-dasharray='40, 10' />"+
			"<text x="+avgLossDuration*10+" y=5 "+avgLossTextAlign+" fill=#f00 dominant-baseline=hanging>avg. "+Math.floor(avgLossDuration*100+0.5)/100+"m</text>"
		}
		
		// Legend
		svgCode +=
			"<g>"+
			"<rect x=-50 y="+(maxGames*10+30+3)+" fill=#888 width=6 height=9 />"+
			"<text x=-40 y="+(maxGames*10+30)+"   fill=#888 dominant-baseline=hanging>Remake</text>"+
			"<rect x=50  y="+(maxGames*10+30+3)+" fill=#0f0 width=6 height=9 />"+
			"<text x=60  y="+(maxGames*10+30)+"   fill=#0f0 dominant-baseline=hanging>Win</text>"+
			"<rect x=120 y="+(maxGames*10+30+3)+" fill=#ff0 width=6 height=9 />"+
			"<text x=130 y="+(maxGames*10+30)+"   fill=#ff0 dominant-baseline=hanging>Win&Loss</text>"+
			"<rect x=220 y="+(maxGames*10+30+3)+" fill=#f00 width=6 height=9 />"+
			"<text x=230 y="+(maxGames*10+30)+"   fill=#f00 dominant-baseline=hanging>Loss</text>"+
			"</g>"
		
		// Scale SVG based on content
		// add 75 and 50 svg-px left and bottom for labels and legend
		durationSvg.setAttribute("viewBox", "-70 0 " + (maxTime*10 + 70) + " " + (maxGames*10 + 50))
		durationSvg.style.width = (maxTime*15 + 105) + "px"
		durationSvg.style.height = (maxGames*15 + 75) + "px"
		durationSvg.innerHTML = svgCode
		
		// Hide some rarely occuring players/items/champs to reduce clutter when many games were analyzed
		var minSum = Math.ceil(Math.log10(wins+losses))
		// Only show all summoners for the initial n games
		// Past that there will be a lot of players (potentially n*9) and the list would grow extremely long
		if (wins+losses > 20)
			var minBattlesForSummoners = 2
		else
			var minBattlesForSummoners = 1
		
		// TODO: Make 2nd parameters depend on table's length instead of wins+losses
		// TODO: Ally- and Enemy items are less interesting and should be more hidden
		resultDiv.innerHTML = "<div>"+
									 playerChampions.toTable("playerchampions", champions)+
									 allyObjectives.toTable ("allyObjectives" , objectives)+
									 enemyObjectives.toTable("enemyObjectives", objectives)+
									 allySummoners.toTable  ("allysummoners",  summoners, minBattlesForSummoners)+
									 enemySummoners.toTable ("enemysummoners", summoners, minBattlesForSummoners)+
									 "</div>"+
									 allyChampions.toTable  ("allychampions",  champions, minSum)+
									 enemyChampions.toTable ("enemychampions", champions, minSum)+
									 playerItems.toTable("playeritems", items)+
									 allyItems.toTable  ("allyitems",   items, minSum * 2)+
									 enemyItems.toTable ("enemyitems",  items, minSum * 2)
									 
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
	// Convert all .notYetSortable to .sortable
	var notYetSortable = resultDiv.getElementsByClassName("notYetSortable")
	while (notYetSortable.length > 0) {
		notYetSortable[0].className = notYetSortable[0].className.replace("notYetSortable", "sortable")
	}
	
	var filterButtons = document.querySelectorAll(".filter")
	for (var i=0; i<filterButtons.length; i++) {
		filterButtons[i].disabled = false
		filterButtons[i].onclick = function() {
			document.getElementById(this.dataset.target).classList.toggle(this.dataset.filter)
		}
	}
	
	// Initialize sorttable
	sorttable.init()
	// Add class to render tables in columns
	//resultDiv.className = "column"
	// TODO: Make button not dis-/reappear in DOM. Instead show/hide via CSS.
	document.getElementById("stop").remove()
}

function reveal(e) {
	e.parentElement.classList.add("showAll")
	e.remove()
}

// takes an object and removes values of null and undefined
// eg. object{honk: true, foo: null} -> object{honk: true}
function compact(obj) {
	for (var key in obj) {
		if (obj[key] == null) delete obj[key]
	}
	return obj
}