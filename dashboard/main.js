const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, session } = require('electron');
const path = require('path');

let isOpenedHidden = false;
let tray = null;
let forceQuit = false;
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const PIPELINE_DIR = app.getPath('userData');
process.env.PIPELINE_DATA_DIR = PIPELINE_DIR;

// Start background analytics (hidden)
try {
    require('../analytics.js');
} catch (e) {
    console.error('Analytics failed to load', e);
}

// Polyfill global File for undici/puppeteer compatibility in Node 18
const { File } = require('buffer');
if (typeof global.File === 'undefined' && File) {
    global.File = File;
}

const { executePipeline, registerDrive } = require('../pipeline.js');

const ENV_PATH = path.join(PIPELINE_DIR, '.env');
const DRIVES_FILE = path.join(PIPELINE_DIR, 'drives.json');
const NEW_DRIVES_FILE = path.join(PIPELINE_DIR, 'new_drives.json');
const SORTED_FILE = path.join(PIPELINE_DIR, 'sorted_companies.json');
const KNOWN_FILE = path.join(PIPELINE_DIR, 'known_drives.json');
const MY_DRIVES_FULL_FILE = path.join(PIPELINE_DIR, 'my_drives_full.json');

let mainWindow;
let pipelineProcess = null; // not used for python anymore, keeping for compatibility if needed
let isPipelineRunning = false;

function createWindow() {
    const env = parseEnv();
    const silent = env['SILENT_STARTUP'] !== 'false';
    isOpenedHidden = (process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden) && silent;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        show: !isOpenedHidden,
        backgroundColor: '#0f0f17',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: !app.isPackaged,
        },
        icon: path.join(__dirname, 'icon.ico'),
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            require('electron').shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Block DevTools shortcuts in production
    if (app.isPackaged) {
        mainWindow.webContents.on('before-input-event', (event, input) => {
            // Block F12
            if (input.key === 'F12') {
                event.preventDefault();
            }
            // Block Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
            if (input.control && input.shift && ['I', 'J', 'C'].includes(input.key)) {
                event.preventDefault();
            }
            // Block Ctrl+U (view source)
            if (input.control && input.key === 'U') {
                event.preventDefault();
            }
        });
    }

    // Intercept window close to hide to tray
    mainWindow.on('close', (event) => {
        if (!forceQuit) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Auto-run pipeline once the window finishes loading
    mainWindow.webContents.on('did-finish-load', () => {
        autoRunPipeline(mainWindow.webContents);
    });
}

async function autoRunPipeline(sender) {
    if (isPipelineRunning) return; // already running
    await runPipelineFlow(sender, false);
}

async function runPipelineFlow(sender, isWatch = false) {
    isPipelineRunning = true;
    sender.send('pipeline:started');
    sender.send('pipeline:log', `[START] Native JS Pipeline started\n`);
    
    let env = parseEnv();
    
    if (!env['USER_ID'] || !env['PASSWORD']) {
        sender.send('pipeline:log', '[ERROR] New user ? Go to Setting to Start\n');
        isPipelineRunning = false;
        sender.send('pipeline:stopped');
        return;
    }

    let sessionCookie = env['ASP.NET_SessionId'] || '';
    
    const logCb = (msg) => sender.send('pipeline:log', msg + '\n');
    
    let result = await executePipeline(sessionCookie, logCb);
    if (result && result.error === 'session_expired') {
        logCb('[WARN] Session expired. Automatically refreshing via Electron window...');
        sessionCookie = await refreshSession(env['USER_ID'], env['PASSWORD'], logCb);
        if (sessionCookie) {
            logCb('[OK] Session refreshed. Resuming pipeline...');
            env['ASP.NET_SessionId'] = sessionCookie;
            writeEnv(env);
            result = await executePipeline(sessionCookie, logCb);
        } else {
            logCb('[FAIL] Could not refresh session. Please check credentials or manually solve Captcha.');
        }
    }
    
    if (result && result.success && result.newDrives && result.newDrives.length > 0) {
        showNewDrivesNotification(result.newDrives);
    }
    
    logCb(`\n[EXIT] Pipeline finished.\n`);
    sender.send('pipeline:stopped');
    sender.send('pipeline:refresh');
    isPipelineRunning = false;
}

// Implement refreshSession using an offscreen BrowserWindow
async function refreshSession(userId, password, logCb) {
    return new Promise((resolve) => {
        let win = new BrowserWindow({ 
            width: 1000, height: 800, show: false, // hidden by default for seamless headless experience
            webPreferences: { partition: 'persist:lpu' }
        });
        
        win.loadURL("https://ums.lpu.in/lpuums/");
        
        let hasNavigatedToPlacements = false;
        let ticks = 0;
        let checkInterval = setInterval(async () => {
            ticks++;
            if (ticks > 5 && !win.isDestroyed() && !win.isVisible()) {
                if (!mainWindow || !mainWindow.isVisible()) {
                    logCb('[WARN] Session refresh requires manual intervention. Notifying user.');
                    clearInterval(checkInterval);
                    win.destroy();
                    showSessionExpiredNotification();
                    resolve(null);
                    return;
                } else {
                    logCb('[WARN] Auto-login taking longer than expected. Showing window for manual fallback...');
                    win.show();
                }
            }

            if (win.isDestroyed()) {
                clearInterval(checkInterval);
                resolve(null);
                return;
            }
            try {
                const url = win.webContents.getURL();
                
                // Auto dismiss popup and physically click navigation links if on dashboard
                await win.webContents.executeJavaScript(`
                    new Promise((resolve) => {
                        // Dismiss popups
                        const remindBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Remind'));
                        const dismissBtn = document.querySelector('button[data-dismiss="modal"]');
                        if (remindBtn) remindBtn.click();
                        else if (dismissBtn) dismissBtn.click();
                        
                        // If already navigating or not on dashboard, resolve
                        if (window.location.href.toLowerCase().includes('placement')) return resolve(false);

                        // Try to click placement link
                        const placementLink = document.querySelector('a[href="frmPlacementHome.aspx"]');
                        if (placementLink && placementLink.offsetParent !== null) {
                            placementLink.click();
                            resolve(true);
                        } else {
                            // Click Academics dropdown first
                            const academicsLink = Array.from(document.querySelectorAll('a.nav-link.dropdown-toggle')).find(a => a.textContent && a.textContent.includes('Academics'));
                            if (academicsLink) {
                                academicsLink.click();
                                setTimeout(() => {
                                    const pLink = document.querySelector('a[href="frmPlacementHome.aspx"]');
                                    if (pLink) pLink.click();
                                    resolve(true);
                                }, 1000);
                            } else {
                                resolve(false);
                            }
                        }
                    });
                `).catch(() => {});

                if (!url.toLowerCase().includes('login') && !url.toLowerCase().includes('lpuums/default.aspx')) {
                     if (url.toLowerCase().includes('placement')) {
                         const cookies = await win.webContents.session.cookies.get({ domain: "ums.lpu.in" });
                         const hasSession = cookies.some(c => c.name === 'ASP.NET_SessionId');
                         if (hasSession) {
                             clearInterval(checkInterval);
                             const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                             win.close();
                             resolve(cookieStr);
                         }
                     }
                }
            } catch(e){}
        }, 2000);

        win.webContents.on('did-finish-load', async () => {
            try {
                const url = win.webContents.getURL();
                if (url.includes("lpuums") && !url.includes('StudentDashboard')) {
                    await win.webContents.executeJavaScript(`
                        new Promise((resolve) => {
                            const txt = document.querySelector('input[type="text"]');
                            const pwd = document.querySelector('input[type="password"]');
                            if (txt && pwd && !txt.value) {
                                txt.value = '${userId || ''}';
                                pwd.value = '${password || ''}';
                                
                                let attempts = 0;
                                let iv = setInterval(() => {
                                    attempts++;
                                    const el = document.querySelector('[name="cf-turnstile-response"]') || document.querySelector('input[name*="turnstile"]');
                                    const passed = (el && el.value && el.value.length > 10) || (!document.querySelector('.cf-turnstile, #cf-turnstile'));
                                    
                                    if (passed || attempts > 60) {
                                        clearInterval(iv);
                                        const btn = document.querySelector('input[type="submit"], button[type="submit"], #btnLogin');
                                        if (btn) { btn.click(); resolve(true); }
                                    }
                                }, 1000);
                            } else { resolve(false); }
                        });
                    `);
                }
            } catch(e) {}
        });
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Dashboard', click: () => {
            mainWindow.show();
            mainWindow.focus();
        }},
        { label: 'Sync Now', click: () => {
            if (mainWindow && !isPipelineRunning) {
                runPipelineFlow(mainWindow.webContents, false);
            }
        }},
        { label: 'Quit', click: () => {
            forceQuit = true;
            app.quit();
        }}
    ]);
    tray.setToolTip('LPU Placement Tracker');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function showSessionExpiredNotification() {
    if (Notification.isSupported()) {
        const notif = new Notification({
            title: 'LPU Placement Tracker',
            body: 'Session Expired: Please click here to re-authenticate with UMS.',
            icon: path.join(__dirname, 'icon.ico')
        });
        notif.on('click', () => {
            mainWindow.show();
            mainWindow.focus();
            if (!isPipelineRunning) {
                runPipelineFlow(mainWindow.webContents, false);
            }
        });
        notif.show();
    }
}

function showNewDrivesNotification(newDrives) {
    if (Notification.isSupported() && newDrives.length > 0) {
        const companyNames = newDrives.map(d => d.Company).slice(0, 3).join(', ') + (newDrives.length > 3 ? '...' : '');
        const notif = new Notification({
            title: 'New Placement Drives!',
            body: `New placement drives detected for: ${companyNames}. Click to view.`,
            icon: path.join(__dirname, 'icon.ico')
        });
        notif.on('click', () => {
            mainWindow.show();
            mainWindow.focus();
        });
        notif.show();
    }
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    // Set Content Security Policy headers in production
    if (app.isPackaged) {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [
                        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://ums.lpu.in https://us.i.posthog.com https://ipapi.co"
                    ]
                }
            });
        });
    }
    
    // Auto Update Logic
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify();
        
        autoUpdater.on('update-available', (info) => {
            if (mainWindow) {
                mainWindow.webContents.send('pipeline:log', `[INFO] Update available (v${info.version}). Downloading...\n`);
            }
        });
        
        autoUpdater.on('update-downloaded', (info) => {
            dialog.showMessageBox({
                type: 'info',
                title: 'Update Ready',
                message: `Version ${info.version} has been downloaded. The application will restart to install the update.`,
                buttons: ['Restart and Update']
            }).then(() => {
                autoUpdater.quitAndInstall();
            });
        });
    }
});

app.on('window-all-closed', () => {
    if (pipelineProcess) pipelineProcess.kill();
    // Do not quit app, run in tray
});

// --- Window controls ---
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.on('win:close', () => mainWindow?.hide());

// --- File readers ---
function safeReadJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
}

ipcMain.handle('data:drives', () => safeReadJSON(DRIVES_FILE));
ipcMain.handle('data:newDrives', () => safeReadJSON(NEW_DRIVES_FILE));
ipcMain.handle('data:sorted', () => safeReadJSON(SORTED_FILE));
ipcMain.handle('data:known', () => safeReadJSON(KNOWN_FILE));
ipcMain.handle('data:myDrivesFull', () => {
    if (fs.existsSync(MY_DRIVES_FULL_FILE)) {
        return safeReadJSON(MY_DRIVES_FULL_FILE);
    }
    const devPath = path.join(__dirname, '..', 'my_drives_full.json');
    if (fs.existsSync(devPath)) {
        return safeReadJSON(devPath);
    }
    return null;
});

// --- ENV config ---
function parseEnv() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    const env = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return env;
}

function writeEnv(data) {
    const lines = [];
    for (const [k, v] of Object.entries(data)) {
        lines.push(`${k}=${v}`);
    }
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

ipcMain.handle('config:load', () => parseEnv());
ipcMain.handle('config:save', (_, data) => {
    try {
        writeEnv(data);
        const openAtLogin = app.getLoginItemSettings().openAtLogin;
        const silent = data['SILENT_STARTUP'] !== 'false';
        app.setLoginItemSettings({
            openAtLogin: openAtLogin,
            args: silent ? ['--hidden'] : []
        });
        return { ok: true };
    }
    catch (e) { return { ok: false, error: e.message }; }
});

// --- Pipeline control ---
let watchModeInterval = null;

ipcMain.handle('pipeline:status', () => ({
    running: isPipelineRunning,
}));

ipcMain.on('pipeline:run', async (event, mode) => {
    if (isPipelineRunning) {
        event.sender.send('pipeline:log', '[WARN] Pipeline already running\n');
        return;
    }

    if (mode === 'watch') {
        event.sender.send('pipeline:log', '[START] Starting Watch mode (runs every 10 min)\n');
        await runPipelineFlow(event.sender, true);
        watchModeInterval = setInterval(() => {
            if (!isPipelineRunning) runPipelineFlow(event.sender, true);
        }, 10 * 60 * 1000);
    } else {
        await runPipelineFlow(event.sender, false);
    }
});

ipcMain.on('pipeline:stop', (event) => {
    if (watchModeInterval) {
        clearInterval(watchModeInterval);
        watchModeInterval = null;
        event.sender.send('pipeline:log', '[STOP] Watch mode stopped.\n');
    }
    // We cannot easily kill a running async JS pipeline without worker threads,
    // but we can mark it as stopped logically if we want. For now, stopping watch mode is enough.
});

// --- Startup Settings ---
ipcMain.handle('startup:get', () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('startup:set', (_, enable) => {
    const env = parseEnv();
    const silent = env['SILENT_STARTUP'] !== 'false';
    app.setLoginItemSettings({
        openAtLogin: enable,
        args: silent ? ['--hidden'] : []
    });
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('drive:register', async (event, companyName) => {
    let env = parseEnv();
    if (!env['USER_ID'] || !env['PASSWORD']) {
        return { error: 'Please set your User ID and Password in Settings first.' };
    }
    
    const logCb = (msg) => {
        if (mainWindow) {
            mainWindow.webContents.send('pipeline:log', msg + '\n');
        }
        console.log(msg);
    };
    
    logCb(`\n[REGISTER] Received request for ${companyName}`);
    let sessionCookie = env['ASP.NET_SessionId'] || '';
    
    let attempt = 0;
    while (attempt < 2) {
        if (!sessionCookie) {
            logCb(`[REGISTER] Session cookie missing. Refreshing session...`);
            sessionCookie = await refreshSession(env['USER_ID'], env['PASSWORD'], logCb);
            if (sessionCookie) {
                env['ASP.NET_SessionId'] = sessionCookie;
                writeEnv(env);
            } else {
                return { error: 'Failed to refresh session. Please check credentials or manually solve Captcha.' };
            }
        }
        
        const res = await registerDrive(sessionCookie, companyName, logCb);
        if (res.error === 'session_expired' || (res.error && res.error.includes('expired'))) {
            logCb(`[REGISTER] Session expired. Clearing cookie and retrying...`);
            sessionCookie = '';
            env['ASP.NET_SessionId'] = '';
            writeEnv(env);
            attempt++;
            continue;
        }
        
        if (res.success) {
            logCb(`[REGISTER] Request successful! Syncing updated placement drives list...`);
            executePipeline(sessionCookie, logCb).then(() => {
                if (mainWindow) {
                    mainWindow.webContents.send('pipeline:refresh');
                }
            }).catch(err => {
                logCb(`[REGISTER] Sync failed: ${err.message}`);
            });
        }
        return res;
    }
    return { error: 'Failed to register after session refresh.' };
});

ipcMain.handle('portal:open', async (event, url) => {
    let env = parseEnv();
    let sessionCookie = env['ASP.NET_SessionId'] || '';
    const logCb = (msg) => console.log(msg);
    
    if (!sessionCookie && env['USER_ID'] && env['PASSWORD']) {
        sessionCookie = await refreshSession(env['USER_ID'], env['PASSWORD'], logCb);
        if (sessionCookie) {
            env['ASP.NET_SessionId'] = sessionCookie;
            writeEnv(env);
        }
    }
    
    const ses = session.fromPartition('persist:lpu');
    if (sessionCookie) {
        const value = sessionCookie.includes('ASP.NET_SessionId=') 
            ? sessionCookie.split('ASP.NET_SessionId=')[1].split(';')[0].trim()
            : sessionCookie.trim();
            
        await ses.cookies.set({
            url: 'https://ums.lpu.in',
            name: 'ASP.NET_SessionId',
            value: value,
            domain: 'ums.lpu.in',
            path: '/',
            secure: true,
            httpOnly: true
        });
    }
    
    let portalWin = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        title: 'LPU Placement Portal',
        autoHideMenuBar: true,
        webPreferences: {
            partition: 'persist:lpu',
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    portalWin.loadURL(url);
    
    portalWin.webContents.on('did-finish-load', async () => {
        const currentUrl = portalWin.webContents.getURL();
        if (currentUrl.toLowerCase().includes('login') && env['USER_ID'] && env['PASSWORD']) {
            console.log('[PORTAL] Session expired on page load. Refreshing...');
            const newCookie = await refreshSession(env['USER_ID'], env['PASSWORD'], logCb);
            if (newCookie) {
                env['ASP.NET_SessionId'] = newCookie;
                writeEnv(env);
                
                const newValue = newCookie.includes('ASP.NET_SessionId=') 
                    ? newCookie.split('ASP.NET_SessionId=')[1].split(';')[0].trim()
                    : newCookie.trim();
                
                await ses.cookies.set({
                    url: 'https://ums.lpu.in',
                    name: 'ASP.NET_SessionId',
                    value: newValue,
                    domain: 'ums.lpu.in',
                    path: '/',
                    secure: true,
                    httpOnly: true
                });
                
                portalWin.loadURL(url);
            }
        }
    });
});




