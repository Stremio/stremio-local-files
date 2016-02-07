var MATCH_FILES = /.mkv$|.avi$|.mp4$|.mov$/;

var VIDEO_INDEXING_INTERVAL = 3*60*1000;
var VIDEO_INDEXING_CHECK = 10*1000;
var VIDEO_INDEX_THROTTLING = 3000;

// Run an FS walk on directories we suspect might hold movies / tv series as a fallback to using Spotlight / Windows Search
// has to be two seconds because of Windows slow IO
var SCAN_FALLBACK_TIMEOUT = 3000;

var async = require("async");
var fs = require("fs");
var walk = require("walk");
var child = require("child_process");
var byline = require("byline");
var path = require("path");

var DSPath = path.dirname(__dirname+"\\bin\\DS.exe");

/* Automatically import files into the database using the Windows Search SDK / OS X Spotlight
 */
var firstImportDone = false, hasResults = false; // set to true after the first import has been done
async.forever(function(callback)
{
    /* Documentation for the querying on Windows: http://msdn.microsoft.com/en-us/library/aa965711(v=vs.85).aspx
     * and on OS X: http://osxnotes.net/spotlight.html
     * TODO: for Mac, we can use -live and always listen on mdfind
     */
    try {
        var searchProcess;
        if (process.platform.match("darwin")) searchProcess = child.exec("mdfind '(kMDItemFSName=*.avi || kMDItemFSName=*.mp4 || kMDItemFSName=*.mkv || kMDItemFSName=*.torrent) " + (firstImportDone ? "&& kMDItemFSContentChangeDate >= $time.today(-1)'" : "'"))
        if (process.platform.match("win32")) searchProcess = child.spawn(DSPath, [ "/b", "/e", "avi,mp4,mkv,mov,torrent" ].concat(firstImportDone ? ["modified:today"] : []));
        if (searchProcess) {
            byline.createStream(searchProcess.stdout).on("data", exploreFile);
            searchProcess.on("exit", function(code) { firstImportDone = true; setTimeout(callback, VIDEO_INDEXING_INTERVAL) });                
            searchProcess.on("error", function(e) { console.error(e) });
        }
    } catch(e) { if (e) callback(e) };

    
    /* 
     * Fallback in case something breaks with mdfind / DS.exe (DS.exe requires .NET)
     * Scan Documents, Downloads, Desktop, Videos for a maximum of a half a second
     * CONSIDER DISABLING THAT
     */
    if (! (firstImportDone && hasResults)) {
        var home = process.env.USERPROFILE || process.env.HOME;
        var paths = [ /*path.join(home, "Documents"), path.join(home, "My Documents"),*/ path.join(home, "Downloads"), path.join(home, "Videos"), path.join(home, "Desktop"), "E:\\Movies", "D:\\Movies"];
        var timedOut = false;
        setTimeout(function() { timedOut = true }, SCAN_FALLBACK_TIMEOUT);

        paths.forEach(function(scanPath) { 
            // TODO: max depth here instead of timeout
            var walker = walk.walk(scanPath);
            walker.on("file", function(root, file, next) {
                if (timedOut) return; // don't call next, stop walking; we may have the walker in memory, but no way to clean it up for now
                //if (file && isFileInteresting(file.name)) console.log("fallback "+file.name);
                if (file && isFileInteresting(file.name)) exploreFile(path.join(root,file.name));
                
                // TODO: CONSIDER: throttle calling of next; e.g. 100 calls per second?
                next();
            });

            //walker.on("end", function() { });
            walker.on("error", function() { });
        });
    };
}, function(err) { console.error(err) });


function isFileInteresting(f) {
    if (f.match("stremio-cache")) return false;
    return f.match(MATCH_FILES) || f.match(".torrent$");
};

/* Storage
 */
var levelup = require("levelup");
var medeadown = require("medeadown");
var sublevel = require("level-sublevel");

var dataDir = path.join(process.env.APPDATA || process.env.HOME);
if (process.platform=="darwin") dataDir = path.join(dataDir, "Library/Application Support");
dataDir = path.join(dataDir, process.platform=="linux" ? ".stremio" : "stremio");
console.log("Using dataDir: -> "+dataDir);

var db = sublevel(levelup(path.join(dataDir, "stremio-local-files"), { valueEncoding: "json", db: medeadown }));
var files = db.sublevel("files");
var meta = db.sublevel("meta");


/* Index
 */
var nameToImdb = require("name-to-imdb");
var parseVideoName = require("video-name-parser");
var parseTorrent = require("parse-torrent");

function exploreFile(p) {
    hasResults = true;
    var p = p.toString();

    if (! isFileInteresting(p)) return;

    if (p.match(/.torrent$/)) return fs.readFile(p, function(err, buf) {
    	if (err) console.error(err);
    	if (buf) parseTorrent(buf).files.forEach(indexFile);
    });
    
    fs.stat(p, function(err, s) {
    	indexFile({ path: p, name: path.basename(p), length: s.size })
    })
    //console.log(parseVideoName(p, { strict: true, fromInside: true, /* fileLength: TODO */ }));
}

function indexFile(f) {
	console.log(f)
};