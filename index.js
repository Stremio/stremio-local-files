var MATCH_FILES = /.mkv$|.avi$|.mp4$|.mov$/;

var VIDEO_INDEXING_INTERVAL = 1*60*1000;
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

var DSPath = path.join(__dirname, "bin", "DS.exe");

function log() {
    (process.env.LOCAL_FILES_LOG || require.main===module) && console.log.apply(console, arguments);
}

/* Storage system
 */
var storage = {
    _data: { },
    put: function(id, data, cb) { storage._data[id] = data; if (cb) cb() },
    get: function(id, cb) { cb(null, storage._data[id]) },
    forAll: function(forKey, onEnd) {
        Object.keys(storage._data).forEach(function(k) { forKey({ key: k, value: storage._data[k] }) })
        onEnd()
    }
}

/* Automatically import files into the database using the Windows Search SDK / OS X Spotlight
 */
var firstImportDone = false, hasResults = false; // set to true after the first import has been done
setTimeout(function() {
    async.forever(scanSystem, function(err) { console.error(err) });
}, 5*1000); // don't put system load immediately after initialization

function scanSystem(callback)
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
            byline.createStream(searchProcess.stdout).on("data", function(line) { exploreFile(line.toString()) });
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
                if (file && isFileInteresting(file.name)) exploreFile(path.join(root, file.name));
                
                // TODO: CONSIDER: throttle calling of next; e.g. 100 calls per second?
                next();
            });

            //walker.on("end", function() { });
            walker.on("error", function() { });
        });
    };
}

function isFileInteresting(f) {
    if (typeof(f) !== "string") { 
        console.log("isFileInteresting called with wrong arg: ", f);
        return false;
    }
    if (f.match("stremio-cache")) return false;
    return f.match(MATCH_FILES) || f.match(".torrent$");
};

/* Storage
 */

/* Index
 */
var nameToImdb = require("name-to-imdb");
var parseVideoName = require("video-name-parser");
var parseTorrent = require("parse-torrent-file");

function exploreFile(file) {
    hasResults = true;
    var p = typeof(file) == "string" ? file : file.path;

    if (! isFileInteresting(p)) return;
    //if (! /^[\000-\177]*$/.test(p)) return log("WARNING temporary disabled non-utf8 paths",p);

    if (p.match(/.torrent$/)) return fs.readFile(p, function(err, buf) {
        if (err) console.error(err);
        if (buf) { 
            try { 
                var tor = parseTorrent(buf);
            } catch(e) { return console.error(e, p) }
            
            tor.files.forEach(function(f, i) {
                f.path = path.join(p, f.path);
                f.torrentInfo = { ih: tor.infoHash, idx: i, announce: tor.announce };
                exploreFile(f);
            });
        }
    });
    
    storage.get("files:"+p, function(err, f) {
        log("-> "+(f ? "HAS INDEXED" : "NEW") +" "+p);

        if (f) return;

        if (file.path) indexFile(file); else fs.stat(p, function(err, s) {
            if (s) indexFile({ path: p, name: path.basename(p), length: s.size });
        });
    });
}

function getHashes(x) {
    return (Array.isArray(x.episode) ? x.episode : [x.episode]).map(function(ep) {
        return [x.imdb_id, x.season, ep ].filter(function(x) { return x }).join(" ")
    });
}

function indexFile(f) {
    var parsed = parseVideoName(f.path, { strict: true, fromInside: true, fileLength: f.length });
    if (["movie", "series"].indexOf(parsed.type) === -1) return storage.put("file:"+f.path, { uninteresting: true });

    // strict means don't lookup google
    nameToImdb({ name: parsed.name, year: parsed.year, type: parsed.type, strict: true }, function(err, imdb_id) {
        if (err) console.error(err);
        if (! imdb_id) return storage.put("files:"+f.path, { uninteresting: true });

        parsed.imdb_id = imdb_id;
        parsed.fname = f.name; parsed.path = f.path; parsed.length = f.length; 
        parsed.torrentInfo = f.torrentInfo;
        storage.put("files:"+f.path, parsed);

        getHashes(parsed).forEach(function(hash) {
            log("-> DISCOVERED "+hash);
            storage.get("meta:"+hash, function(err, files) {
                files = files || { };
                files[f.path] = 1;
                storage.put("meta:"+hash, files);
            });
        });
    });
};


/* Interface
 */
var Stremio = require("stremio-addons");

var manifest = { 
    "name": "Local",
    "description": "Watch from local files",
    "id": "org.stremio.local",
    "version": require("./package").version,

    "types": ["movie", "series"],
    "idProperty": "imdb_id",
    
    // OBSOLETE; used instead of types/idProperty before stremio 4.0
    "filter": { "query.imdb_id": { "$exists": true }, "query.type": { "$in":["series","movie"] } }
};

var methods = { };
var addon = new Stremio.Server(methods, { stremioget: true }, manifest);

// Listen to 3033 if we're stand-alone
if (require.main===module) var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() })
}).on("listening", function()
{
    console.log("Local Files Addon listening on "+server.address().port);
}).listen(process.env.PORT || 3033);

// Export for local usage
module.exports = addon;

// Get stream
methods["stream.find"] = function(args, callback) {
    if (! args.query) return callback();
    var hash = getHashes(args.query)[0];

    storage.get("meta:"+hash, function(err, paths) {
        if (! paths) return callback(null, []);

        async.map(Object.keys(paths), function(id, cb) {
            storage.get("files:"+id, function(err, f) {
                if (err &&  err.type == "NotFoundError") return cb(null, null);
                else cb(err, f);
            });
        }, function(err, all) {
            if (err) { console.error(err); return callback(new Error("internal")); }

            callback(null, all.map(function(f) {
                return f.torrentInfo ? {
                    infoHash: f.torrentInfo.ih, mapIdx: f.torrentInfo.idx,
                    sources: [ "dht:"+f.torrentInfo.ih ].concat(f.torrentInfo.announce.map(function(x) { return "tracker:"+x })),
                    title: f.fname,
                    name: "Local Torrent",
                    tag: f.tag
                } : { 
                    url: "file://"+f.path,
                    title: f.fname,
                    name: "Local File",
                    tag: f.tag
                }
            }));
        });
    });
};

// Catalogue / listing
var addons = new Stremio.Client();
addons.add("http://cinemeta.strem.io/stremioget/stremio/v1");
methods["meta.find"] = function(args, callback) {
    var ids = { };
    storage.forAll(function(m) {
        // meta: - 5 chars
        if (m.key.indexOf("meta:") === 0) {
            var k = m.key.slice(5).split(" ")[0];
            if (k.indexOf("tt") === 0) ids[k] = (ids[k] || 0) + 1;
        }
    }, function() {
        if (args && args.query) args.query.imdb_id = args.query.imdb_id || { $in: Object.keys(ids) };
        addons.meta.find(args, callback);
    })
};

// override storage
module.exports.setStorage = function(st) {
    storage = st
}
