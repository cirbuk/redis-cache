const fs = require('fs');
const pkg = require('../package');

delete pkg.devDependencies;
delete pkg.scripts;

fs.writeFileSync(`${process.env.DIR}/package.json`, JSON.stringify(pkg));
