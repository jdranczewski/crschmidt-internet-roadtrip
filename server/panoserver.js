const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const port = 8081;
const dbFile = './data.sqlite'; // Database file will be created in the same directory

// Middleware
app.use(express.json({limit: "50mb"}));
app.use(cors()); // Enable CORS for all origins

// --- Database Setup ---
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            panoId TEXT NOT NULL,
            clickedLat REAL NOT NULL,
            clickedLng REAL NOT NULL,
            actualLat REAL NOT NULL,
            actualLng REAL NOT NULL,
            distance REAL NOT NULL,
            source TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('Error creating table "items"', err.message);
            } else {
                console.log('Table "items" is ready or already exists.');
            }
        });
    }
});

// --- Helper Function: Haversine Distance ---
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c; // Distance in km
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// --- API Endpoints ---

// POST /add
app.post('/add', (req, res) => {
    const editDb = new sqlite3.Database(dbFile);
    const items = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ status: 'error', error: 'Request body must be a non-empty JSON array.' });
        return;
    }

    // Validate all items before starting transaction
    for (const item of items) {
        const { panoId, clickedLat, clickedLng, actualLat, actualLng } = item;
        if (panoId === undefined || typeof clickedLat !== 'number' || typeof clickedLng !== 'number' || typeof actualLat !== 'number' || typeof actualLng !== 'number') {
            res.status(400).json({ status: 'error', error: 'One or more items are missing required fields (panoId, clickedLat, clickedLng, actualLat, actualLng) or fields have incorrect types.' });
            return;
        }
    }

    editDb.serialize(() => {
        editDb.run("PRAGMA busy_timeout=60000");
        editDb.run("BEGIN TRANSACTION;", function(beginErr) {
            if (beginErr) {
                console.error("Transaction start error:", beginErr.message);
                res.status(500).json({ status: 'error', error: `Transaction start error: ${beginErr.message}` });
                return;
            }

            const stmt = editDb.prepare("INSERT INTO items (panoId, clickedLat, clickedLng, actualLat, actualLng, distance, timestamp, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            let errorOccurred = false;
            let lastErrorMessage = '';

            items.forEach(item => {
                let source = 'unknown';
                if (errorOccurred) return; // Stop processing if an error has already occurred in a previous iteration

                const { panoId, clickedLat, clickedLng, actualLat, actualLng } = item;
                if (item.source) { source = item.source; }
                const distance = getDistance(clickedLat, clickedLng, actualLat, actualLng);
                const timestamp = new Date().toISOString();

                // The callback for stmt.run is important for error handling within the loop
                stmt.run(panoId, clickedLat, clickedLng, actualLat, actualLng, distance, timestamp, source, function(runErr) {
                    if (runErr) {
                        errorOccurred = true;
                        lastErrorMessage = `Error inserting item (panoId: ${panoId}): ${runErr.message}`;
                        console.error(lastErrorMessage);
                        // Note: The transaction will be rolled back after the loop, in stmt.finalize
                    }
                });
            });

            // Finalize the statement. This is called after all stmt.run calls in the loop are queued.
            stmt.finalize((finalizeErr) => {
                if (finalizeErr && !errorOccurred) { // If an error hasn't already been caught from stmt.run
                    errorOccurred = true;
                    lastErrorMessage = `Error finalizing statement: ${finalizeErr.message}`;
                    console.error(lastErrorMessage);
                }

                if (errorOccurred) {
                    editDb.run("ROLLBACK;", (rollbackErr) => {
                        if (rollbackErr) {
                            console.error("Rollback error:", rollbackErr.message);
                            // Send a more comprehensive error message if rollback also fails
                            res.status(500).json({ status: 'error', error: `Transaction rollback failed: ${rollbackErr.message} after initial error: ${lastErrorMessage}` });
                            return;
                        }
                        res.status(500).json({ status: 'error', error: lastErrorMessage });
                        return;
                    });
                } else {
                    editDb.run("COMMIT;", (commitErr) => {
                        if (commitErr) {
                            console.error("Transaction commit error:", commitErr.message);
                            // If commit fails, the transaction is typically rolled back automatically by SQLite,
                            // but an explicit ROLLBACK can be attempted for safety, though it might also error.
                            editDb.run("ROLLBACK;", (rbErrOnCommitFail) => {
                                if (rbErrOnCommitFail) console.error("Rollback attempt after commit failure also failed:", rbErrOnCommitFail.message);
                            });
                            res.status(500).json({ status: 'error', error: `Transaction commit error: ${commitErr.message}` });
                            return;
                        }
                        res.json({ status: 'ok' });
                        return;
                    });
                }
            });
        });
    });
});
// GET /list
app.get('/shortlist', (req, res) => {
    const { id, min_distance } = req.query;
    let query = "SELECT clickedLat, clickedLng FROM items";
    let out = []
    db.all(query, {}, (err, rows) => {
        if (err) {
            console.error("Database query error:", err.message);
            res.status(500).json({ status: 'error', error: `Database query error: ${err.message}` });
            return;
        }
        rows.forEach(row => {
            out.push([row.clickedLat, row.clickedLng]);
        });
        res.json(out);
    });
});
// GET /list
app.get('/list', (req, res) => {
    const { id, min_distance, format, min_lat, max_lat, min_lng, max_lng } = /** @type {Record<string, string>} */ (req.query);
    let query = "SELECT id, panoId, clickedLat, clickedLng, actualLat, actualLng, distance, timestamp FROM items";
    const params = [];
    const conditions = [];

    if (id !== undefined) {
        if (isNaN(parseInt(id))) {
            res.status(400).json({ status: 'error', error: 'Invalid id parameter. Must be an integer.' });
            return;
        }
        conditions.push("id = ?");
        params.push(parseInt(id));
    }

    if (min_lat !== undefined) {
      const minLat = parseFloat(min_lat);
      if (isNaN(minLat)) {
          res.status(400).json({ status: 'error', error: 'Invalid min_distance parameter. Must be a number.' });
          return;
      }
      conditions.push("clickedLat > ?");
      params.push(minLat);
   }
    if (min_lng !== undefined) {
      const minLng = parseFloat(min_lng);
      if (isNaN(minLng)) {
          res.status(400).json({ status: 'error', error: 'Invalid min_distance parameter. Must be a number.' });
          return;
      }
      conditions.push("clickedLng > ?");
      params.push(minLng);
   }
    if (max_lat !== undefined) {
      const maxLat = parseFloat(max_lat);
      if (isNaN(maxLat)) {
          res.status(400).json({ status: 'error', error: 'Invalid max_distance parameter. Must be a number.' });
          return;
      }
      conditions.push("clickedLat < ?");
      params.push(maxLat);
   }
    if (max_lng !== undefined) {
      const maxLng = parseFloat(max_lng);
      if (isNaN(maxLng)) {
          res.status(400).json({ status: 'error', error: 'Invalid max_distance parameter. Must be a number.' });
          return;
      }
      conditions.push("clickedLng < ?");
      params.push(maxLng);
   }

    if (min_distance !== undefined) {
        const minDist = parseFloat(min_distance);
        if (isNaN(minDist)) {
            res.status(400).json({ status: 'error', error: 'Invalid min_distance parameter. Must be a number.' });
            return;
        }
        conditions.push("distance > ?");
        params.push(minDist);
    }

    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("Database query error:", err.message);
            res.status(500).json({ status: 'error', error: `Database query error: ${err.message}` });
            return;
        }
        if (format == "short") {
            let out = [];
            rows.forEach(row => {
                out.push([row.clickedLat, row.clickedLng]);
            });
            res.json(out);
        } else {
            res.json(rows);
        }
    });
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('\nCaught interrupt signal. Closing database connection...');
    db.close((err) => {
        if (err) {
            console.error('Error closing the database', err.message);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(err ? 1 : 0);
    });
});
