'use strict';
// Write JSON so a crash or power cut mid-write can't leave a half-written file.
// A half-written state.json used to read back as {} and wipe every label on the next save.

const fs = require('fs');
const path = require('path');

function writeJson(file, value, space) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, space));
  fs.renameSync(tmp, file);
}

module.exports = { writeJson };
