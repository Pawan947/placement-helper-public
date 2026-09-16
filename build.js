/**
 * build.js — Full build orchestrator
 * 
 * 1. Cleans dist/ and build-src/
 * 2. Runs obfuscation (copies + obfuscates source to build-src/)
 * 3. Installs production dependencies in build-src/
 * 4. Runs electron-builder to produce the installer
 * 
 * Usage: node build.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STAGE_DIR = path.join(ROOT, 'build-src');
const DIST_DIR = path.join(ROOT, 'dist');

function run(cmd, cwd = ROOT) {
    console.log(`\n> ${cmd}\n`);
    execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env } });
}

function main() {
    console.log('========================================');
    console.log('  Placement Helper — Production Build');
    console.log('========================================\n');

    // Step 1: Clean previous build artifacts
    console.log('[Step 1/5] Cleaning previous builds...');
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
        console.log('  Cleaned dist/');
    }
    if (fs.existsSync(STAGE_DIR)) {
        fs.rmSync(STAGE_DIR, { recursive: true, force: true });
        console.log('  Cleaned build-src/');
    }

    // Step 2: Run obfuscation
    console.log('\n[Step 2/5] Running obfuscation...');
    run('node obfuscate.js');

    // Step 3: Install production dependencies in staging
    console.log('\n[Step 3/5] Installing production dependencies in build-src/...');
    run('npm install --omit=dev', STAGE_DIR);
    
    // Also install dashboard dependencies
    const dashboardDir = path.join(STAGE_DIR, 'dashboard');
    if (fs.existsSync(path.join(dashboardDir, 'package.json'))) {
        run('npm install --omit=dev', dashboardDir);
    }

    // Step 4: Build with electron-builder
    console.log('\n[Step 4/5] Building with electron-builder...');
    run(`npx electron-builder --win --x64 --project "${STAGE_DIR}" --config "${path.join(ROOT, 'electron-builder.json')}"`, ROOT);

    // Step 5: Verify output
    console.log('\n[Step 5/5] Verifying build output...');
    const exeFiles = findFiles(DIST_DIR, '.exe');
    if (exeFiles.length > 0) {
        console.log('  Build artifacts:');
        exeFiles.forEach(f => console.log(`    ✓ ${path.relative(ROOT, f)}`));
    } else {
        console.log('  Looking for unpacked build...');
        const unpackedDir = path.join(DIST_DIR, 'win-unpacked');
        if (fs.existsSync(unpackedDir)) {
            console.log(`    ✓ ${path.relative(ROOT, unpackedDir)}`);
        }
    }

    console.log('\n========================================');
    console.log('  Build complete!');
    console.log('========================================\n');
}

function findFiles(dir, ext) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findFiles(fullPath, ext));
        } else if (entry.name.endsWith(ext)) {
            results.push(fullPath);
        }
    }
    return results;
}

main();
