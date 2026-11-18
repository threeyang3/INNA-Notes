"use strict";

const { Timers } = require("./timers.js");
const { NotesSession } = require("./service.js");

// IINA creates a separate Main Entry for each player window.
const timers = new Timers(setTimeout, clearTimeout);
const session = new NotesSession(iina, timers);
session.start().catch(error => iina.console.error("IINA Video Notes: " + error.message));
