const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { spawn, fork } = require('child_process');

const SCRIPT_DIR = __dirname;
const DATA_DIR = process.env.PIPELINE_DATA_DIR || SCRIPT_DIR;
const DRIVES_FILE = path.join(DATA_DIR, 'drives.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known_drives.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'new_drives.json');
const NEWEST_FILE = path.join(DATA_DIR, 'newest_drives.json');
const SORTED_FILE = path.join(DATA_DIR, 'sorted_companies.json');

const BASE_URL = "https://ums.lpu.in/Placements/";
const PAGE_URL = BASE_URL + "HomePlacementStudent.aspx";

function log(msg, callback) {
    console.log(msg);
    if (callback) callback(msg + '\n');
}

function getCookieHeader(sessionCookie) {
    if (!sessionCookie) return '';
    if (sessionCookie.includes('=')) {
        return sessionCookie;
    }
    return `ASP.NET_SessionId=${sessionCookie}`;
}

// === STEP 1: Fetch and Parse Main Table ===
async function fetchDrivesPage(sessionCookie, logCb) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://ums.lpu.in/lpuums/StudentDashboard.aspx",
        "Cookie": getCookieHeader(sessionCookie)
    };
    try {
        const resp = await axios.get(PAGE_URL, { headers, timeout: 20000 });
        if (resp.data.toLowerCase().includes('login') && resp.data.toLowerCase().includes('password')) {
            return { error: 'session_expired' };
        }
        logCb("[OK] Main page fetched");
        return { $: cheerio.load(resp.data) };
    } catch (e) {
        logCb(`[FAIL] Main page fetch error: ${e.message}`);
        return { error: e.message };
    }
}

function parseDriveTable($, tableEl) {
    let table = tableEl;
    if (!table || !table.length) {
        table = $('#ctl00_ContentPlaceHolder1_gdvPlacement');
        if (!table.length) {
            $('table').each((i, el) => {
                const text = $(el).text();
                if (text.includes('Company') && (text.includes('Register By') || text.includes('Register'))) {
                    table = $(el);
                    return false; // break
                }
            });
        }
    }
    if (!table || !table.length) return [];

    const rows = table.find('tr').toArray();
    if (rows.length <= 1) return [];

    // Find header row dynamically
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < rows.length; i++) {
        const cols = $(rows[i]).find('th, td').map((_, c) => $(c).text().trim()).get();
        if (cols.some(c => c.includes('Company') || c.includes('Register'))) {
            headers = cols;
            headerIdx = i;
            break;
        }
    }

    const colMap = {};
    if (headerIdx !== -1) {
        headers.forEach((h, idx) => {
            const hLower = h.toLowerCase();
            if (hLower.includes('company') || hLower.includes('recruiter') || hLower.includes('organization') || hLower.includes('employer')) {
                colMap['Company'] = idx;
            } else if (hLower.includes('register by') || hLower.includes('deadline') || hLower.includes('reg. by') || hLower.includes('apply by') || hLower.includes('last date')) {
                colMap['Register By'] = idx;
            } else if (hLower.includes('date') && !hLower.includes('register') && !hLower.includes('deadline') && !hLower.includes('apply') && !hLower.includes('last')) {
                colMap['Drive Date'] = idx;
            } else if (hLower.includes('job profile') || hLower.includes('profile') || hLower.includes('role') || hLower.includes('designation')) {
                colMap['Job Profile'] = idx;
            } else if (hLower.includes('status') && !hLower.includes('register') && !hLower.includes('applied')) {
                colMap['Status'] = idx;
            } else if (hLower.includes('register') || hLower.includes('applied')) {
                colMap['Registered'] = idx;
            } else if (hLower.includes('hall ticket') || hLower.includes('ticket') || hLower.includes('admit')) {
                colMap['Hall Ticket'] = idx;
            }
        });
    } else {
        // Hardcoded fallbacks
        colMap['Drive Date'] = 0;
        colMap['Register By'] = 1;
        colMap['Company'] = 2;
        colMap['Job Profile'] = 3;
        colMap['Status'] = 4;
        colMap['Registered'] = 5;
        colMap['Hall Ticket'] = 6;
    }

    const startRow = headerIdx !== -1 ? headerIdx + 1 : 1;
    const drives = [];

    for (let i = startRow; i < rows.length; i++) {
        const cells = $(rows[i]).find('td');
        if (!cells.length) continue;

        const compIdx = colMap['Company'];
        if (compIdx === undefined || compIdx >= cells.length) continue;
        const company = $(cells[compIdx]).text().trim();
        if (!company) continue;

        const jobIdx = colMap['Job Profile'];
        let jobUrl = null;
        if (jobIdx !== undefined && jobIdx < cells.length) {
            const jobA = $(cells[jobIdx]).find('a');
            if (jobA.length && jobA.attr('href')) {
                const href = jobA.attr('href');
                jobUrl = href.startsWith('http') ? href : BASE_URL + href;
            }
        }

        const regIdx = colMap['Registered'];
        let registered = '';
        if (regIdx !== undefined && regIdx < cells.length) {
            const regA = $(cells[regIdx]).find('a');
            registered = regA.length ? regA.text().trim() : $(cells[regIdx]).text().trim();
        }

        const hallIdx = colMap['Hall Ticket'];
        let hallUrl = null;
        if (hallIdx !== undefined && hallIdx < cells.length) {
            const htA = $(cells[hallIdx]).find('a');
            if (htA.length && htA.attr('href')) {
                const href = htA.attr('href');
                hallUrl = href.startsWith('http') ? href : BASE_URL + href;
            }
        }

        const driveDateIdx = colMap['Drive Date'];
        const driveDate = (driveDateIdx !== undefined && driveDateIdx < cells.length) ? $(cells[driveDateIdx]).text().trim() : "Will be Notified Later";

        const regByIdx = colMap['Register By'];
        const registerBy = (regByIdx !== undefined && regByIdx < cells.length) ? $(cells[regByIdx]).text().trim() : "";

        const statusIdx = colMap['Status'];
        const status = (statusIdx !== undefined && statusIdx < cells.length) ? $(cells[statusIdx]).text().trim() : "";

        drives.push({
            "Drive Date": driveDate,
            "Register By": registerBy,
            "Company": company,
            "Job Profile URL": jobUrl,
            "Status": status,
            "Registered": registered,
            "Hall Ticket URL": hallUrl,
            "Details": null
        });
    }
    return drives;
}

async function fetchTab(sessionCookie, $, targetButton, logCb) {
    const params = new URLSearchParams();
    
    // Serialize all input, select, and textarea elements
    $('input, select, textarea').each((_, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return;
        
        const type = $el.attr('type') ? $el.attr('type').toLowerCase() : '';
        
        // Skip buttons/submit types since postback is triggered via __EVENTTARGET
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
            return;
        }
        
        if (type === 'checkbox' || type === 'radio') {
            if ($el.prop('checked')) {
                params.set(name, $el.val() || 'on');
            }
        } else if ($el.is('select')) {
            const val = $el.val();
            if (val !== null) {
                params.set(name, val);
            }
        } else {
            params.set(name, $el.val() || '');
        }
    });

    params.set('__EVENTTARGET', targetButton);
    params.set('__EVENTARGUMENT', '');

    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": PAGE_URL,
        "Cookie": getCookieHeader(sessionCookie),
        "Content-Type": "application/x-www-form-urlencoded"
    };

    try {
        const resp = await axios.post(PAGE_URL, params.toString(), { headers, timeout: 20000 });
        if (resp.status === 200) {
            return cheerio.load(resp.data);
        } else {
            logCb(`[WARN] Postback for ${targetButton} returned status ${resp.status}`);
        }
    } catch (e) {
        logCb(`[WARN] Postback for ${targetButton} failed: ${e.message}`);
    }
    return null;
}

async function fetchAllTabsDrives(sessionCookie, initial$, logCb) {
    let initialTable = initial$('#ctl00_ContentPlaceHolder1_gdvPlacement');
    if (!initialTable.length) {
        initial$('table').each((i, el) => {
            const text = initial$(el).text();
            if (text.includes('Company') && (text.includes('Register By') || text.includes('Register'))) {
                initialTable = initial$(el);
                return false; // break
            }
        });
    }

    const allDrives = parseDriveTable(initial$, initialTable);
    const discovered = [];
    
    initial$('input, button, a').each((_, element) => {
        const el = initial$(element);
        const elName = el.attr('name');
        const elId = el.attr('id');
        const elValue = el.attr('value') || el.text().trim();
        
        let elClass = el.attr('class') || '';
        if (Array.isArray(elClass)) {
            elClass = elClass.join(' ');
        }
        const elClassLower = elClass.toLowerCase().split(/\s+/);
        
        const onclick = el.attr('onclick') || '';
        const href = el.attr('href') || '';
        
        let postbackTarget = null;
        for (const text of [onclick, href]) {
            if (text && text.includes('__doPostBack')) {
                const match = text.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/);
                if (match) {
                    postbackTarget = match[1];
                    break;
                }
            }
        }
        
        const targetName = postbackTarget || elName || elId;
        if (!targetName) return;
        
        const valLower = elValue.toLowerCase();
        const targetLower = targetName.toLowerCase();
        
        // Exclude elements that are clearly not tab navigation (e.g. search, submit, reset, logout)
        const nonTabKeywords = ['search', 'submit', 'clear', 'reset', 'export', 'download', 'print', 'logout', 'back', 'cancel', 'admit', 'ticket', 'profile', 'apply', 'register'];
        const isNonTab = nonTabKeywords.some(k => targetLower.includes(k) || valLower.includes(k));
        
        let isTab = false;
        if (!isNonTab) {
            // Heuristic 1: CSS classes contain tab, menu, nav
            if (elClassLower.some(c => c.includes('tab') || c.includes('menu') || c.includes('nav'))) {
                isTab = true;
            }
            // Heuristic 2: Name/ID contains placement button terms
            if (['btninternship', 'btnshortterm', 'btnother', 'btnregular', 'btnplacement', 'btntab', 'btnplacements'].some(k => targetLower.includes(k))) {
                isTab = true;
            }
            // Heuristic 3: ASP.NET ContentPlaceholder button pattern
            if (targetLower.includes('contentplaceholder1$btn') || targetLower.includes('contentplaceholder1_btn')) {
                isTab = true;
            }
            // Heuristic 4: Display text matches placement keywords
            if (['internship', 'shortterm', 'short-term', 'short term', 'winter internship', 'summer internship', 'live project', 'regular placement', 'other placement', 'placement', 'drives', 'training'].some(k => valLower.includes(k))) {
                isTab = true;
            }
        }
        
        if (isTab) {
            let eventTarget = targetName;
            if (eventTarget.includes('_') && !eventTarget.includes('$')) {
                eventTarget = eventTarget.replace(/_/g, '$');
            }
            // Support multiple active indicators
            const activeIndicators = ['active', 'active-tab', 'selected', 'current', 'active_tab', 'btn-active'];
            const isActive = elClassLower.some(c => activeIndicators.includes(c) || c.includes('active'));
            
            discovered.push({
                target: eventTarget,
                value: elValue || eventTarget,
                active: isActive
            });
        }
    });

    const seenTargets = {};
    for (const item of discovered) {
        const normalized = item.target.replace(/_/g, '$');
        if (!seenTargets[normalized]) {
            seenTargets[normalized] = { value: item.value, active: item.active };
        } else if (item.active) {
            seenTargets[normalized].active = true;
        }
    }
    
    logCb(`[INFO] Discovered tab targets dynamically: ${Object.keys(seenTargets).join(', ')}`);
    
    if (Object.keys(seenTargets).length === 0) {
        const defaultTargets = [
            { target: "ctl00$ContentPlaceHolder1$btnInternship", value: "Internship", active: false },
            { target: "ctl00$ContentPlaceHolder1$btnShortterm", value: "Shortterm", active: false },
            { target: "ctl00$ContentPlaceHolder1$btnOther", value: "Other", active: false }
        ];
        for (const item of defaultTargets) {
            seenTargets[item.target] = { value: item.value, active: item.active };
        }
    }
    
    const activeTargets = Object.keys(seenTargets).filter(t => seenTargets[t].active);
    
    for (const [target, info] of Object.entries(seenTargets)) {
        if (activeTargets.length === 1 && target === activeTargets[0]) {
            logCb(`[INFO] Skipping postback for active tab: ${info.value}`);
            continue;
        }
        
        logCb(`Fetching tab: ${info.value} (${target}) ...`);
        const tab$ = await fetchTab(sessionCookie, initial$, target, logCb);
        if (tab$) {
            let tabTable = tab$('#ctl00_ContentPlaceHolder1_gdvPlacement');
            if (!tabTable.length) {
                tab$('table').each((i, el) => {
                    const text = tab$(el).text();
                    if (text.includes('Company') && (text.includes('Register By') || text.includes('Register'))) {
                        tabTable = tab$(el);
                        return false;
                    }
                });
            }
            if (tabTable.length) {
                const tabDrives = parseDriveTable(tab$, tabTable);
                logCb(`[OK] Found ${tabDrives.length} drives in tab '${info.value}'`);
                allDrives.push(...tabDrives);
            } else {
                logCb(`[WARN] No drive table found in tab '${info.value}'`);
            }
        }
    }

    const seenDrives = new Set();
    const uniqueDrives = [];
    for (const d of allDrives) {
        const key = `${d.Company || ''}|${d['Job Profile URL'] || ''}`;
        if (!seenDrives.has(key)) {
            seenDrives.add(key);
            uniqueDrives.push(d);
        }
    }
    
    logCb(`[OK] Total unique drives across all tabs: ${uniqueDrives.length}`);
    return uniqueDrives;
}

// === STEP 2: Instant Alert ===
function getDriveKey(d) {
    return `${d.Company || ''}|${d['Job Profile URL'] || ''}`;
}

function detectNewDrives(drives) {
    let known = new Set();
    if (fs.existsSync(KNOWN_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'));
            known = new Set(data.keys || []);
        } catch (e) {}
    }

    const currentKeys = new Set(drives.map(getDriveKey));
    const newDrives = [];

    for (const d of drives) {
        if (known.has(getDriveKey(d))) continue;
        const status = (d.Status || '').toLowerCase();
        const registered = (d.Registered || '').toLowerCase();
        const isRegistered = registered.includes('yes') || registered.includes('cancel');
        if (status.includes('closed') && !isRegistered) continue;
        newDrives.push(d);
    }

    const merged = new Set([...known, ...currentKeys]);
    fs.writeFileSync(KNOWN_FILE, JSON.stringify({ keys: Array.from(merged), updated: new Date().toISOString() }));
    return newDrives;
}

function sendInstantAlert(newDrives, logCb) {
    logCb(`\n[ALERT] ${newDrives.length} NEW DRIVE(S) detected (instant alert removed)`);
}

// === STEP 3: Fetch Details (drive.py) ===
const DETAIL_FIELDS = [
    "Drive Code", "Name & Type of Event", "Name of Company",
    "Year (Passing Out)", "Venue", "Drive Date", "Whom to contact",
    "Last Date of Registration", "Eligible Gender", "Bond Details",
    "Skills Required", "About Company", "Website", "Job Profile",
    "Pre-Requirements", "Tentative Date of Joining"
];

function getField($, label) {
    let found = null;
    $('td').each((i, el) => {
        if ($(el).text().trim() === label) {
            const sibling = $(el).next('td');
            if (sibling.length) {
                found = sibling.text().trim().replace(/\s+/g, ' ');
            }
        }
    });
    return found;
}

async function fetchDriveDetails(drive, sessionCookie, logCb) {
    const url = drive['Job Profile URL'];
    if (!url) { drive.Details = null; return drive; }

    try {
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "text/html,application/xhtml+xml",
            "Cookie": getCookieHeader(sessionCookie)
        };
        const r = await axios.get(url, { headers, timeout: 20000 });
        if (r.status !== 200) { drive.Details = { error: `HTTP ${r.status}` }; return drive; }

        const $ = cheerio.load(r.data);
        const details = {};
        for (const field of DETAIL_FIELDS) {
            const val = getField($, field);
            if (val) details[field] = val;
        }

        const streams = [];
        const streamTable = $('#tblStreamData');
        if (streamTable.length) {
            let hdrs = [];
            streamTable.find('tr').each((i, row) => {
                const cells = $(row).find('th, td').map((_, c) => $(c).text().trim()).get();
                if (i === 0) hdrs = cells;
                else {
                    const rowObj = {};
                    hdrs.forEach((h, idx) => rowObj[h] = cells[idx]);
                    streams.push(rowObj);
                }
            });
        }
        details.Streams = streams;

        let rounds = [];
        $('table').each((_, tbl) => {
            const firstRow = $(tbl).find('tr').first().text();
            if (firstRow.includes('Round Name')) {
                let hdrs = [];
                $(tbl).find('tr').each((i, row) => {
                    const cells = $(row).find('th, td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
                    if (i === 0) hdrs = cells;
                    else {
                        const rowObj = {};
                        hdrs.forEach((h, idx) => rowObj[h] = cells[idx]);
                        rounds.push(rowObj);
                    }
                });
                return false; // break
            }
        });
        details["Selection Process Rounds"] = rounds;
        drive.Details = details;
    } catch (e) {
        drive.Details = { error: e.message };
    }
    logCb(`  [OK] ${drive.Company}`);
    return drive;
}

// === STEP 4: Place.py HTML Parser ===
function cleanText(text) { return text ? text.replace(/\s+/g, ' ').trim() : ""; }

function parseDriveHtml(html) {
    const $ = cheerio.load(html);
    const data = {
        drive_type: null, full_title: null, company: null, role: null, batch: null, location: null, drive_code: null,
        job_profile: {}, selection_process: [], contact_details: {}, company_information: {}, pre_requirements: {}, links: {}
    };

    const hero = $('.hero-card');
    if (hero.length) {
        data.drive_type = cleanText(hero.find('.badge-drive').text());
        const fullTitle = cleanText(hero.find('h2').text());
        data.full_title = fullTitle;
        if (fullTitle && fullTitle.includes('-')) {
            const pts = fullTitle.split('-');
            data.company = pts[0].trim();
            data.role = pts.slice(1).join('-').trim();
        } else if (fullTitle) {
            data.company = fullTitle;
        }
        data.batch = cleanText(hero.find('i[class*="graduation"]').parent().text());
        data.location = cleanText(hero.find('i[class*="map-marker"]').parent().text());
        data.drive_code = cleanText(hero.find('h5').text());
    }

    $('.info-card').each((_, card) => {
        const heading = $(card).find('h6').text();
        if (!heading) return;
        const key = cleanText(heading).toLowerCase().replace(/ /g, '_');
        const valDiv = $(card).find('div[class*="info-value"], div[class*="salary-package"], div[class*="salary-desc"]');
        if (valDiv.length) data[key] = cleanText(valDiv.text());
    });

    const jobBox = $('#jobProfileBox');
    if (jobBox.length) {
        const jobData = { full_text: cleanText(jobBox.text()), skills: [], details: [] };
        jobBox.find('span[class*="badge"]').each((_, b) => {
            const t = cleanText($(b).text());
            if (t && t !== 'YES' && t !== 'NO' && !jobData.skills.includes(t)) jobData.skills.push(t);
        });
        jobBox.find('p, div, li').each((_, p) => {
            const t = cleanText($(p).text());
            if (t && t.length > 20 && !jobData.details.includes(t)) jobData.details.push(t);
        });
        data.job_profile = jobData;
    }

    const selBox = $('#selectionBox table');
    if (selBox.length) {
        selBox.find('tr').slice(1).each((_, row) => {
            const cols = $(row).find('td');
            if (cols.length >= 5) {
                data.selection_process.push({
                    round_name: cleanText($(cols[0]).text()),
                    expected_start_time: cleanText($(cols[1]).text()),
                    expected_end_time: cleanText($(cols[2]).text()),
                    description: cleanText($(cols[3]).text()),
                    is_elimination: cleanText($(cols[4]).text())
                });
            }
        });
    }

    $('#contactBox .col-md-6').each((_, col) => {
        const t = cleanText($(col).text());
        if (t.includes('Whom to contact:')) data.contact_details.contact_person = t;
        else if (t.includes('For any Query Contact:')) data.contact_details.query_contact = t;
        else if (t.includes('Drive Date:')) data.contact_details.drive_date = t;
        else if (t.includes('Tentative Date of Joining:')) data.contact_details.joining_date = t;
    });

    const compBox = $('#companyBox');
    if (compBox.length) {
        const about = compBox.find('strong').filter((_, el) => /About Company/i.test($(el).text()));
        if (about.length) data.company_information.about_company = cleanText(about.parent().text());
        const web = compBox.find('a[href]').attr('href');
        if (web) data.company_information.website = web;
    }

    const reqBox = $('#preReqBox');
    if (reqBox.length) {
        data.pre_requirements = { full_text: cleanText(reqBox.text()), requirements: [], links: [] };
        reqBox.find('.alert').each((_, a) => {
            const t = cleanText($(a).text());
            if (t) data.pre_requirements.requirements.push(t);
        });
        const urls = data.pre_requirements.full_text.match(/https?:\/\/[^\s]+/g);
        if (urls) data.pre_requirements.links = urls;
    }

    $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        const text = cleanText($(a).text());
        if (text.includes('Register')) data.links.registration_link = href;
        if (href.toLowerCase().endsWith('.pdf')) data.links.jd_pdf = href;
    });

    return data;
}

async function runPlacePy(sessionCookie, logCb) {
    logCb("Running rich parser (place.py equivalent)...");
    let drives = [];
    if (fs.existsSync(DRIVES_FILE)) drives = JSON.parse(fs.readFileSync(DRIVES_FILE, 'utf8'));

    const urls = drives.filter(d => {
        const status = (d.Status || '').toLowerCase();
        return !status.includes('closed') && d['Job Profile URL'];
    }).map(d => d['Job Profile URL']);

    let existingData = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        try { existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch(e){}
    }
    const existingTitles = new Set(existingData.map(d => d.full_title).filter(Boolean));
    const collected = [];

    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml",
        "Cookie": getCookieHeader(sessionCookie)
    };
    for (let i = 0; i < urls.length; i++) {
        logCb(`  [${i+1}/${urls.length}] ${urls[i]}`);
        try {
            const r = await axios.get(urls[i], { headers, timeout: 20000 });
            if (r.data.toLowerCase().includes('login') && r.data.toLowerCase().includes('password')) continue;
            const parsed = parseDriveHtml(r.data);
            collected.push(parsed);
            logCb(`    [OK] ${parsed.company || 'Unknown'}`);
        } catch(e) { logCb(`    [FAIL] ${e.message}`); }
    }

    const newest = collected.filter(d => !existingTitles.has(d.full_title));
    fs.writeFileSync(NEWEST_FILE, JSON.stringify(newest.length ? newest : { message: "no new drives" }, null, 4));

    const merged = {};
    existingData.forEach(d => { if (d.full_title) merged[d.full_title] = d; });
    collected.forEach(d => { if (d.full_title) merged[d.full_title] = d; });
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(Object.values(merged), null, 4));
    logCb(`[OK] Saved parsed drives`);
}

// === STEP 5: Sorter ===
function parseDateStr(str) {
    if (!str) return null;
    // try dd/mm/yyyy hh:mm
    const parts = str.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (parts) {
        return new Date(parts[3], parts[2] - 1, parts[1], parts[4], parts[5]);
    }
    return new Date(str); // fallback
}

function runSorter(logCb) {
    if (!fs.existsSync(OUTPUT_FILE)) return;
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const now = new Date();
    const active = [];

    data.forEach(company => {
        const dateStr = company.apply_before || company.last_date_of_registration || company['Register By'] || "";
        const dt = parseDateStr(dateStr);
        if (dt && !isNaN(dt) && dt >= now) active.push({ dt, company });
    });

    active.sort((a, b) => a.dt - b.dt);
    const companies = {};
    active.forEach((item, idx) => companies[idx + 1] = item.company);

    fs.writeFileSync(SORTED_FILE, JSON.stringify({ total: active.length, companies }, null, 4));
    logCb(`[OK] Sorter: ${active.length} active drives`);
}

// === STEP 6: Prepare WhatsApp Message ===
function hoursUntil(dt) {
    return dt ? ((dt - new Date()) / 3600000) : null;
}
function humanCountdown(hours) {
    if (hours === null) return "TBD";
    if (hours < 1) return `${Math.floor(hours * 60)} minutes`;
    if (hours < 24) return `${Math.floor(hours)} hours`;
    const days = hours / 24;
    if (days < 2) return `~${Math.floor(hours)} hours (${Math.ceil(days)} day)`;
    return `${Math.ceil(days)} days`;
}

// WhatsApp integration removed

// === MAIN PIPELINE RUNNER ===
async function executePipeline(sessionCookie, logCb) {
    logCb(`\n[START] Pipeline running...`);
    const pageRes = await fetchDrivesPage(sessionCookie, logCb);
    if (pageRes && pageRes.error === 'session_expired') {
        return { error: 'session_expired' };
    }
    if (!pageRes || !pageRes.$) {
        return { error: 'fetch_failed' };
    }

    const drives = await fetchAllTabsDrives(sessionCookie, pageRes.$, logCb);
    logCb(`[OK] ${drives.length} upcoming drives found`);
    if (drives.length === 0) return { success: true };

    const newDrives = detectNewDrives(drives);
    let sentInstant = false;
    if (newDrives.length > 0) {
        sendInstantAlert(newDrives, logCb);
        sentInstant = true;
    } else {
        logCb("[OK] No new drives since last check");
    }

    logCb("Fetching drive details...");
    await Promise.all(drives.map(d => fetchDriveDetails(d, sessionCookie, logCb)));

    fs.writeFileSync(DRIVES_FILE, JSON.stringify(drives, null, 2));
    logCb(`[OK] Saved drives.json`);

    // Update/merge into my_drives_full.json
    try {
        const MY_DRIVES_FULL_FILE = path.join(DATA_DIR, 'my_drives_full.json');
        let fullDrives = [];
        if (fs.existsSync(MY_DRIVES_FULL_FILE)) {
            fullDrives = JSON.parse(fs.readFileSync(MY_DRIVES_FULL_FILE, 'utf8'));
        } else {
            // fallback to reading from workspace if running for the first time
            const fallbackPath = path.join(SCRIPT_DIR, 'my_drives_full.json');
            if (fs.existsSync(fallbackPath)) {
                fullDrives = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
            }
        }
        
        // Merge drives (drives has latest status/info for current drives)
        // Use Company + Job Profile URL as unique key
        const driveMap = new Map();
        fullDrives.forEach(d => {
            const key = `${d.Company || ''}|${d['Job Profile URL'] || ''}`;
            driveMap.set(key, d);
        });
        
        drives.forEach(d => {
            const key = `${d.Company || ''}|${d['Job Profile URL'] || ''}`;
            driveMap.set(key, d);
        });
        
        fs.writeFileSync(MY_DRIVES_FULL_FILE, JSON.stringify(Array.from(driveMap.values()), null, 2));
        logCb(`[OK] Merged and saved my_drives_full.json`);
    } catch (e) {
        logCb(`[WARN] Failed to update my_drives_full.json: ${e.message}`);
    }

    await runPlacePy(sessionCookie, logCb);
    runSorter(logCb);
    
    logCb("\nSkipping notifications...");
    
    logCb(`\n[DONE] Pipeline complete.`);
    return { success: true, newDrives: newDrives };
}

async function registerDrive(sessionCookie, companyName, logCb) {
    logCb(`[REGISTER] Attempting registration for ${companyName}...`);
    
    // Helper to find company row in a Cheerio $ instance
    function findCompanyInTable($, companyName) {
        let table = $('#ctl00_ContentPlaceHolder1_gdvPlacement');
        if (!table.length) {
            $('table').each((i, el) => {
                const text = $(el).text();
                if (text.includes('Company') && (text.includes('Register By') || text.includes('Register'))) {
                    table = $(el);
                    return false; // break
                }
            });
        }
        if (!table || !table.length) return null;
        
        const rows = table.find('tr').toArray();
        let headerIdx = -1;
        let headers = [];
        for (let i = 0; i < rows.length; i++) {
            const cols = $(rows[i]).find('th, td').map((_, c) => $(c).text().trim()).get();
            if (cols.some(c => c.includes('Company') || c.includes('Register'))) {
                headers = cols;
                headerIdx = i;
                break;
            }
        }
        
        const colMap = {};
        if (headerIdx !== -1) {
            headers.forEach((h, idx) => {
                const hLower = h.toLowerCase();
                if (hLower.includes('company') || hLower.includes('recruiter') || hLower.includes('organization') || hLower.includes('employer')) {
                    colMap['Company'] = idx;
                } else if (hLower.includes('register by') || hLower.includes('deadline') || hLower.includes('reg. by') || hLower.includes('apply by') || hLower.includes('last date')) {
                    colMap['Register By'] = idx;
                } else if (hLower.includes('date') && !hLower.includes('register') && !hLower.includes('deadline') && !hLower.includes('apply') && !hLower.includes('last')) {
                    colMap['Drive Date'] = idx;
                } else if (hLower.includes('job profile') || hLower.includes('profile') || hLower.includes('role') || hLower.includes('designation')) {
                    colMap['Job Profile'] = idx;
                } else if (hLower.includes('status') && !hLower.includes('register') && !hLower.includes('applied')) {
                    colMap['Status'] = idx;
                } else if (hLower.includes('register') || hLower.includes('applied')) {
                    colMap['Registered'] = idx;
                } else if (hLower.includes('hall ticket') || hLower.includes('ticket') || hLower.includes('admit')) {
                    colMap['Hall Ticket'] = idx;
                }
            });
        }
        
        if (colMap['Company'] === undefined) {
            colMap['Company'] = 0;
            colMap['Registered'] = 5;
        }
        
        const compIdx = colMap['Company'];
        const regIdx = colMap['Registered'];
        
        const startRow = headerIdx !== -1 ? headerIdx + 1 : 1;
        const cleanStr = (s) => (s || '').replace(/[^a-z0-9]/ig, '').toUpperCase();
        
        for (let i = startRow; i < rows.length; i++) {
            const cells = $(rows[i]).find('td');
            if (!cells.length || cells.length <= compIdx || cells.length <= regIdx) continue;
            
            const rowCompany = $(cells[compIdx]).text().trim();
            const isMatch = 
                rowCompany.toUpperCase() === companyName.toUpperCase() ||
                cleanStr(rowCompany) === cleanStr(companyName) ||
                rowCompany.toUpperCase().includes(companyName.toUpperCase()) ||
                companyName.toUpperCase().includes(rowCompany.toUpperCase());
                
            if (isMatch) {
                return {
                    $,
                    compIdx,
                    regIdx,
                    startRow,
                    row: rows[i]
                };
            }
        }
        return null;
    }

    const pageRes = await fetchDrivesPage(sessionCookie, logCb);
    if (!pageRes || !pageRes.$) {
        return { error: 'Failed to load placement drives page.' };
    }
    const $ = pageRes.$;
    
    // Try to find on the initial page
    let foundContext = findCompanyInTable($, companyName);
    let currentPage$ = $;
    
    if (!foundContext) {
        logCb(`[REGISTER] Company "${companyName}" not found on the default tab. Scanning other tabs...`);
        // Discover tabs from initial page
        const discovered = [];
        $('input, button, a').each((_, element) => {
            const el = $(element);
            const elName = el.attr('name');
            const elId = el.attr('id');
            const elValue = el.attr('value') || el.text().trim();
            
            let elClass = el.attr('class') || '';
            if (Array.isArray(elClass)) elClass = elClass.join(' ');
            const elClassLower = elClass.toLowerCase().split(/\s+/);
            
            const onclick = el.attr('onclick') || '';
            const href = el.attr('href') || '';
            
            let postbackTarget = null;
            for (const text of [onclick, href]) {
                if (text && text.includes('__doPostBack')) {
                    const match = text.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/);
                    if (match) { postbackTarget = match[1]; break; }
                }
            }
            
            const targetName = postbackTarget || elName || elId;
            if (!targetName) return;
            
            const valLower = elValue.toLowerCase();
            const targetLower = targetName.toLowerCase();
            const nonTabKeywords = ['search', 'submit', 'clear', 'reset', 'export', 'download', 'print', 'logout', 'back', 'cancel', 'admit', 'ticket', 'profile', 'apply', 'register'];
            const isNonTab = nonTabKeywords.some(k => targetLower.includes(k) || valLower.includes(k));
            
            let isTab = false;
            if (!isNonTab) {
                if (elClassLower.some(c => c.includes('tab') || c.includes('menu') || c.includes('nav'))) isTab = true;
                if (['btninternship', 'btnshortterm', 'btnother', 'btnregular', 'btnplacement', 'btntab', 'btnplacements'].some(k => targetLower.includes(k))) isTab = true;
                if (targetLower.includes('contentplaceholder1$btn') || targetLower.includes('contentplaceholder1_btn')) isTab = true;
                if (['internship', 'shortterm', 'short-term', 'short term', 'winter internship', 'summer internship', 'live project', 'regular placement', 'other placement', 'placement', 'drives', 'training'].some(k => valLower.includes(k))) isTab = true;
            }
            
            if (isTab) {
                let eventTarget = targetName;
                if (eventTarget.includes('_') && !eventTarget.includes('$')) eventTarget = eventTarget.replace(/_/g, '$');
                const activeIndicators = ['active', 'active-tab', 'selected', 'current', 'active_tab', 'btn-active'];
                const isActive = elClassLower.some(c => activeIndicators.includes(c) || c.includes('active'));
                
                discovered.push({ target: eventTarget, value: elValue || eventTarget, active: isActive });
            }
        });
        
        const seenTargets = {};
        for (const item of discovered) {
            const normalized = item.target.replace(/_/g, '$');
            if (!seenTargets[normalized]) seenTargets[normalized] = { value: item.value, active: item.active };
            else if (item.active) seenTargets[normalized].active = true;
        }
        
        if (Object.keys(seenTargets).length === 0) {
            const defaultTargets = [
                { target: "ctl00$ContentPlaceHolder1$btnInternship", value: "Internship" },
                { target: "ctl00$ContentPlaceHolder1$btnShortterm", value: "Shortterm" },
                { target: "ctl00$ContentPlaceHolder1$btnOther", value: "Other" }
            ];
            for (const item of defaultTargets) seenTargets[item.target] = { value: item.value, active: false };
        }
        
        const activeTargets = Object.keys(seenTargets).filter(t => seenTargets[t].active);
        for (const [target, info] of Object.entries(seenTargets)) {
            if (activeTargets.length === 1 && target === activeTargets[0]) continue; // skip active tab
            
            logCb(`[REGISTER] Scanning tab: ${info.value} ...`);
            const tab$ = await fetchTab(sessionCookie, $, target, logCb);
            if (tab$) {
                foundContext = findCompanyInTable(tab$, companyName);
                if (foundContext) {
                    logCb(`[REGISTER] Found company "${companyName}" in tab "${info.value}"!`);
                    currentPage$ = tab$;
                    break;
                }
            }
        }
    }
    
    if (!foundContext) {
        return { error: `Registration button/link not found for company: ${companyName}. Maybe registration is closed?` };
    }
    
    // Now perform the postback using the correct page context!
    const { compIdx, regIdx, startRow, row } = foundContext;
    const cells = currentPage$(row).find('td');
    
    const regCell = currentPage$(cells[regIdx]);
    const regA = regCell.find('a');
    
    let targetPostback = null;
    let isCurrentlyRegistered = false;
    
    logCb(`[REGISTER] Link elements found: ${regA.length}, Content: "${regCell.text().trim()}"`);
    if (regA.length && regA.attr('href')) {
        const href = regA.attr('href');
        logCb(`[REGISTER] Link href: "${href}"`);
        const m = href.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/);
        if (m) {
            targetPostback = m[1];
        }
        const regText = regA.text().trim().toLowerCase();
        isCurrentlyRegistered = regText.includes('cancel');
    }
    
    if (!targetPostback) {
        return { error: `Postback target not found for company: ${companyName}` };
    }
    
    logCb(`[REGISTER] Found postback target: ${targetPostback}. Current status: ${isCurrentlyRegistered ? 'Registered' : 'Not Registered'}`);
    
    const result$ = await fetchTab(sessionCookie, currentPage$, targetPostback, logCb);
    if (!result$) {
        return { error: 'Failed to submit registration request to LPU UMS.' };
    }
    
    // Now verify the updated status in the updated page!
    const verifiedContext = findCompanyInTable(result$, companyName);
    if (verifiedContext) {
        const verifiedCells = verifiedContext.$(verifiedContext.row).find('td');
        const vRegCell = verifiedContext.$(verifiedCells[verifiedContext.regIdx]);
        const vRegA = vRegCell.find('a');
        const regText = vRegA.length ? vRegA.text().trim() : vRegCell.text().trim();
        const nowReg = regText.toLowerCase().includes('cancel');
        logCb(`[REGISTER] Verification: company ${companyName} status is now: ${regText}`);
        if (nowReg !== isCurrentlyRegistered) {
            return { success: true, message: `Successfully ${nowReg ? 'registered for' : 'cancelled registration for'} ${companyName}!`, registeredStatus: regText };
        } else {
            return { error: `Failed to update registration status. It remains: ${regText}` };
        }
    }
    
    return { success: true, message: `Registration postback sent. Please refresh to verify.` };
}

module.exports = { executePipeline, registerDrive };

// If run directly (not required)
if (require.main === module) {
    const envPath = path.join(__dirname, '.env');
    let sessionCookie = '';
    if (fs.existsSync(envPath)) {
        const m = fs.readFileSync(envPath, 'utf8').match(/ASP\.NET_SessionId=(.*)/);
        if (m) sessionCookie = m[1].trim();
    }
    executePipeline(sessionCookie, msg => process.stdout.write(msg)).then(console.log);
}
