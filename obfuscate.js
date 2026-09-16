/**
 * obfuscate.js — Build-time JavaScript obfuscation
 * 
 * Copies source files to build-src/ staging directory, then obfuscates
 * all JS files in-place using javascript-obfuscator with maximum protection.
 * 
 * Usage: node obfuscate.js
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const STAGE_DIR = path.join(ROOT, 'build-src');

// Files to copy and obfuscate
const JS_FILES = [
    'pipeline.js',
    'analytics.js',
    'dashboard/main.js',
    'dashboard/preload.js',
    'dashboard/renderer.js',
];

// Non-JS files to copy as-is
const COPY_FILES = [
    'package.json',
    'dashboard/package.json',
    'dashboard/index.html',
    'dashboard/styles.css',
];

// Obfuscation config — maximum protection
const OBFUSCATION_OPTIONS = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: true,
    debugProtectionInterval: 2000,
    disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false, // keep false for Node.js require() compatibility
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.75,
    stringArrayEncoding: ['rc4'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // Target Node.js environment for main/pipeline/analytics/preload
    target: 'node',
};

// Renderer needs browser target
const RENDERER_OPTIONS = {
    ...OBFUSCATION_OPTIONS,
    target: 'browser',
    selfDefending: true,
    debugProtection: true,
    debugProtectionInterval: 2000,
};

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function cleanDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function obfuscateFile(filePath, options) {
    const code = fs.readFileSync(filePath, 'utf-8');
    console.log(`  Obfuscating: ${path.relative(STAGE_DIR, filePath)} ...`);
    
    const startTime = Date.now();
    const result = JavaScriptObfuscator.obfuscate(code, options);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    const obfuscatedCode = result.getObfuscatedCode();
    fs.writeFileSync(filePath, obfuscatedCode, 'utf-8');
    
    const originalSize = Buffer.byteLength(code, 'utf-8');
    const newSize = Buffer.byteLength(obfuscatedCode, 'utf-8');
    console.log(`    Done (${elapsed}s) | ${(originalSize / 1024).toFixed(1)}KB -> ${(newSize / 1024).toFixed(1)}KB`);
}

function main() {
    console.log('\n=== Obfuscation Build ===\n');
    
    // 1. Clean staging directory
    console.log('[1/3] Cleaning staging directory...');
    cleanDir(STAGE_DIR);
    
    // 2. Copy files to staging
    console.log('[2/3] Copying source files...');
    
    for (const file of [...JS_FILES, ...COPY_FILES]) {
        const src = path.join(ROOT, file);
        const dest = path.join(STAGE_DIR, file);
        if (fs.existsSync(src)) {
            copyFile(src, dest);
            console.log(`  Copied: ${file}`);
        } else {
            console.warn(`  WARNING: ${file} not found, skipping`);
        }
    }
    
    // Copy icon file if exists
    const iconSrc = path.join(ROOT, 'dashboard', 'icon.ico');
    if (fs.existsSync(iconSrc)) {
        copyFile(iconSrc, path.join(STAGE_DIR, 'dashboard', 'icon.ico'));
        console.log('  Copied: dashboard/icon.ico');
    }
    
    // 3. Obfuscate JS files
    console.log('[3/3] Obfuscating JavaScript files...');
    
    for (const file of JS_FILES) {
        const filePath = path.join(STAGE_DIR, file);
        if (!fs.existsSync(filePath)) continue;
        
        const isRenderer = file.includes('renderer');
        const options = isRenderer ? RENDERER_OPTIONS : OBFUSCATION_OPTIONS;
        
        obfuscateFile(filePath, options);
    }
    
    console.log('\n=== Obfuscation complete! ===');
    console.log(`Staged files in: ${STAGE_DIR}\n`);
}

main();
