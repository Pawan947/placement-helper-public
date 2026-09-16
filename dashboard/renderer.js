// --- Navigation ---
const navBtns = document.querySelectorAll('.nav-btn');
const views = document.querySelectorAll('.view');

navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        navBtns.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
        if (btn.dataset.view === 'dashboard') loadDashboard();
        if (btn.dataset.view === 'drives') loadDrivesTable();
        if (btn.dataset.view === 'settings') loadSettings();
    });
});

// --- Pipeline controls ---
const btnRun = document.getElementById('btnRunOnce');
const btnWatch = document.getElementById('btnWatch');
const btnStop = document.getElementById('btnStop');
const badge = document.getElementById('statusBadge');

function setRunning(on) {
    btnRun.disabled = on;
    btnWatch.disabled = on;
    btnStop.disabled = !on;
    badge.textContent = on ? 'Running' : 'Stopped';
    badge.className = 'status-badge ' + (on ? 'running' : 'stopped');

    // Update sidebar status card
    const statusDot = document.getElementById('syncStatusDot');
    const statusText = document.getElementById('syncStatusText');
    if (statusDot && statusText) {
        statusDot.className = 'status-dot-glowing ' + (on ? 'running' : 'stopped');
        statusText.textContent = on ? 'Syncing...' : 'Ready';
    }
}

btnRun.addEventListener('click', () => { api.runPipeline('once'); setRunning(true); });
btnWatch.addEventListener('click', () => { api.runPipeline('watch'); setRunning(true); });
btnStop.addEventListener('click', () => { api.stopPipeline(); setRunning(false); });

api.onStarted(() => setRunning(true));
api.onStopped(() => { setRunning(false); });

// Refresh data immediately after pipeline finishes
api.onRefresh(async () => {
    cachedNewDrives = null; // clear cache so fresh data is loaded
    // Update last sync time
    updateLastSyncTime(Date.now());
    // Reload whichever view is currently active
    const activeView = document.querySelector('.nav-btn.active');
    const view = activeView?.dataset?.view;
    if (view === 'drives') {
        await loadDrivesTable();
    } else {
        // Default to dashboard refresh
        await loadDashboard();
    }
});

// --- Logs ---
const logBox = document.getElementById('logOutput');
api.onLog(msg => {
    if (logBox) {
        logBox.textContent += msg;
        logBox.scrollTop = logBox.scrollHeight;
    }
    handleStepperLogs(msg);
});
const btnClearLog = document.getElementById('btnClearLog');
if (btnClearLog) {
    btnClearLog.addEventListener('click', () => { if (logBox) logBox.textContent = ''; });
}

// --- Helpers ---
function parseDate(str) {
    if (!str || str === 'Will be Notified Later') return null;
    const parts = str.split(' ');
    if (parts.length >= 2) {
        const [d, m, y] = parts[0].split('/');
        const [hh, mm] = parts[1].split(':');
        return new Date(y, m - 1, d, hh, mm);
    }
    return null;
}

function countdown(dateStr) {
    const dt = parseDate(dateStr);
    if (!dt) return 'TBD';
    const ms = dt - Date.now();
    if (ms < 0) return 'Expired';
    const hrs = Math.floor(ms / 3600000);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.ceil(hrs / 24)}d`;
}

function getEffectiveStatus(d) {
    let status = d.Status || '';
    if (status === 'Open') {
        const timeRemaining = countdown(d['Register By']);
        if (timeRemaining === 'Expired') {
            return 'Registration Closed';
        }
    }
    return status;
}

function statusBadge(status, registered) {
    const reg = (registered || '').toLowerCase();
    const isReg = reg.includes('yes') || reg.includes('cancel');
    if (isReg) return '<span class="badge registered">Registered</span>';
    if (status === 'Open') return '<span class="badge open">Open</span>';
    if (status.includes('Closed')) return '<span class="badge closed">Closed</span>';
    return `<span class="badge">${status}</span>`;
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Detail Panel ---
const detailOverlay = document.getElementById('detailOverlay');
const detailTitle = document.getElementById('detailTitle');
const detailContent = document.getElementById('detailContent');
let cachedNewDrives = null;

document.getElementById('btnCloseDetail').addEventListener('click', closeDetail);
detailOverlay.addEventListener('click', (e) => {
    if (e.target === detailOverlay) closeDetail();
});

// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailOverlay.classList.contains('open')) {
        closeDetail();
    }
});

function closeDetail() {
    detailOverlay.classList.remove('open');
    const activeView = document.querySelector('.nav-btn.active')?.dataset?.view;
    if (activeView === 'dashboard') {
        loadDashboard();
    }
}

async function openCompanyDetail(companyName) {
    // Record view in interest profile for recommendations
    recordView(companyName);

    // Load detailed data from new_drives.json
    if (!cachedNewDrives) {
        cachedNewDrives = await api.getNewDrives() || [];
    }
    // Also get basic data from drives.json
    const drives = await api.getDrives() || [];

    // Find matching detail data (case-insensitive)
    const normalizedName = companyName.trim().toUpperCase();
    const detail = cachedNewDrives.find(d =>
        (d.company || '').trim().toUpperCase() === normalizedName ||
        (d.full_title || '').toUpperCase().includes(normalizedName)
    );

    // Find basic drive data
    let basicDrive = drives.find(d =>
        (d.Company || '').trim().toUpperCase() === normalizedName
    );
    if (!basicDrive) {
        const fullDrives = await api.getMyDrivesFull() || [];
        basicDrive = fullDrives.find(d =>
            (d.Company || '').trim().toUpperCase() === normalizedName
        );
    }

    detailTitle.textContent = companyName;
    detailContent.innerHTML = buildDetailHTML(companyName, detail, basicDrive);
    detailOverlay.classList.add('open');

    const registerBtn = detailOverlay.querySelector('.register-action-btn');
    if (registerBtn) {
        registerBtn.addEventListener('click', async () => {
            const action = registerBtn.dataset.action;
            const company = registerBtn.dataset.company;
            const originalText = registerBtn.innerHTML;

            if (action === 'cancel') {
                if (!confirm(`Are you sure you want to cancel registration for ${company}?`)) {
                    return;
                }
            }

            registerBtn.disabled = true;
            registerBtn.style.opacity = '0.7';
            registerBtn.innerHTML = `<span class="spinner-inline"></span> ${action === 'register' ? 'Registering...' : 'Cancelling...'}`;

            try {
                const res = await api.registerDrive(company);
                if (res.success) {
                    alert(res.message);
                    closeDetail();
                } else {
                    alert(res.error || 'An error occurred.');
                }
            } catch (err) {
                console.error(err);
                alert(`Error: ${err.message || err}`);
            } finally {
                registerBtn.disabled = false;
                registerBtn.style.opacity = '1';
                registerBtn.innerHTML = originalText;
            }
        });
    }

    detailOverlay.querySelectorAll('.view-ums-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const url = btn.dataset.url;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.innerHTML = `<span class="spinner-inline"></span> Opening...`;
            try {
                await api.openPortal(url);
            } catch (err) {
                console.error(err);
                alert(`Error opening window: ${err.message || err}`);
            } finally {
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.innerHTML = originalText;
            }
        });
    });
}

function buildDetailHTML(companyName, detail, basic) {
    let html = '';

    // If we have no detail data at all, show basic info
    if (!detail && !basic) {
        html += `<div class="empty-state">No detailed information available for ${escapeHTML(companyName)}</div>`;
        return html;
    }

    const company = detail?.company || companyName;
    const role = detail?.role || '';
    const initial = company.charAt(0);

    // ── Hero Section ──
    const driveType = detail?.drive_type || '';
    const batch = detail?.batch || '';
    const location = detail?.location || '';
    const driveCode = detail?.drive_code || '';

    html += `<div class="detail-hero">
        <div class="detail-hero-icon">${escapeHTML(initial)}</div>
        <div class="detail-hero-info">
            <h2>${escapeHTML(company)}</h2>
            ${role ? `<div class="role">${escapeHTML(role)}</div>` : ''}
            <div class="detail-hero-meta">
                ${driveType ? `<span class="meta-chip"><span class="chip-icon">&#9733;</span> ${escapeHTML(driveType)}</span>` : ''}
                ${batch ? `<span class="meta-chip"><span class="chip-icon">&#127891;</span> ${escapeHTML(batch)}</span>` : ''}
                ${location ? `<span class="meta-chip"><span class="chip-icon">&#128205;</span> ${escapeHTML(location)}</span>` : ''}
                ${driveCode ? `<span class="meta-chip"><span class="chip-icon">&#128196;</span> ${escapeHTML(driveCode)}</span>` : ''}
            </div>
        </div>
    </div>`;

    // ── Action Buttons ──
    const regLink = detail?.links?.registration_link;
    const jdPdf = detail?.links?.jd_pdf;
    const profileUrl = basic?.['Job Profile URL'];
    const hallTicket = basic?.['Hall Ticket URL'];

    const regStatus = (basic?.Registered || '').toLowerCase();
    const isClosed = (basic?.Status || '').toLowerCase().includes('closed');
    const canRegister = !isClosed && regStatus.includes('register');
    const canCancel = !isClosed && regStatus.includes('cancel');

    if (canRegister || canCancel || regLink || jdPdf || profileUrl || hallTicket) {
        html += `<div class="detail-actions">`;
        if (canRegister) {
            html += `<button class="detail-action-btn primary register-action-btn" data-company="${escapeHTML(companyName)}" data-action="register">&#9998; Register Directly</button>`;
        } else if (canCancel) {
            html += `<button class="detail-action-btn danger register-action-btn" data-company="${escapeHTML(companyName)}" data-action="cancel">&#10006; Cancel Registration</button>`;
        }
        if (regLink) html += `<a href="${escapeHTML(regLink)}" target="_blank" class="detail-action-btn primary">&#9998; Register (External)</a>`;
        if (profileUrl) html += `<button class="detail-action-btn secondary view-ums-btn" data-url="${escapeHTML(profileUrl)}">&#128279; View on UMS</button>`;
        if (jdPdf) html += `<a href="${escapeHTML(jdPdf)}" target="_blank" class="detail-action-btn secondary">&#128196; Download JD (PDF)</a>`;
        if (hallTicket) html += `<button class="detail-action-btn secondary view-ums-btn" data-url="${escapeHTML(hallTicket)}">&#127915; Hall Ticket</button>`;
        html += `</div>`;
    }

    // ── Key Info Grid ──
    const salary = detail?.salary_package || '';
    const eligibility = detail?.eligibility || '';
    const bond = detail?.bond_details || '';
    const applyBefore = detail?.apply_before || '';
    const regBy = basic?.['Register By'] || '';
    const driveDate = basic?.['Drive Date'] || '';
    const status = basic ? getEffectiveStatus(basic) : '';
    const registered = basic?.Registered || '';

    const infoItems = [];
    if (status) {
        const regLower = (registered || '').toLowerCase();
        const isReg = regLower.includes('yes') || regLower.includes('cancel');
        const statusLabel = isReg ? 'Registered' : status;
        const statusClass = isReg ? 'green' : (status === 'Open' ? 'green' : 'red');
        infoItems.push({ label: 'Status', value: statusLabel, cls: statusClass });
    }
    if (regBy) infoItems.push({ label: 'Register By', value: regBy + ` (${countdown(regBy)})`, cls: countdown(regBy) === 'Expired' ? 'red' : 'orange' });
    if (driveDate) infoItems.push({ label: 'Drive Date', value: driveDate });
    if (salary) infoItems.push({ label: 'Salary / Package', value: salary, cls: 'green' });
    if (eligibility) infoItems.push({ label: 'Eligibility', value: eligibility });
    if (applyBefore) infoItems.push({ label: 'Apply Before', value: applyBefore, cls: 'orange' });
    if (bond) infoItems.push({ label: 'Bond', value: bond });

    if (infoItems.length) {
        html += `<div class="detail-info-grid">`;
        for (const item of infoItems) {
            html += `<div class="detail-info-item">
                <div class="info-label">${escapeHTML(item.label)}</div>
                <div class="info-value ${item.cls || ''}">${escapeHTML(item.value)}</div>
            </div>`;
        }
        html += `</div>`;
    }

    // ── Job Profile ──
    if (detail?.job_profile && detail.job_profile.full_text) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Job Profile</div>
            <div class="detail-text-block">${formatJobText(detail.job_profile.full_text)}</div>`;

        if (detail.job_profile.skills && detail.job_profile.skills.length) {
            html += `<div class="skills-tags">`;
            for (const skill of detail.job_profile.skills) {
                html += `<span class="skill-tag">${escapeHTML(skill)}</span>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    }

    // ── Selection Process Timeline ──
    const selectionData = detail?.selection_process || basic?.Details?.['Selection Process Rounds'] || [];
    if (selectionData.length) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Selection Process</div>
            <div class="process-timeline">`;

        for (const round of selectionData) {
            const name = round.round_name || round['Round Name'] || '';
            const desc = round.description || round['Round Description'] || '';
            const startTime = round.expected_start_time || round['Expected Start Time'] || '';
            const isElim = (round.is_elimination || round['Is Elimination'] || '').toUpperCase() === 'YES';
            const elimClass = isElim ? 'elimination' : 'not-elimination';
            const elimBadge = isElim
                ? '<span class="step-badge elim">Elimination</span>'
                : '<span class="step-badge safe">Non-Elimination</span>';

            html += `<div class="process-step ${elimClass}">
                <div class="step-name">${escapeHTML(name)} ${elimBadge}</div>
                <div class="step-meta">${escapeHTML(desc)}${startTime && startTime !== 'Will be notified later' ? ` · ${escapeHTML(startTime)}` : ''}</div>
            </div>`;
        }
        html += `</div></div>`;
    }

    // ── Company Information ──
    if (detail?.company_information && Object.keys(detail.company_information).length) {
        html += `<div class="detail-section">
            <div class="detail-section-title">About Company</div>
            <div class="company-about">`;
        if (detail.company_information.about_company) {
            const aboutText = detail.company_information.about_company.replace(/^About Company:\s*/i, '');
            html += `<p>${escapeHTML(aboutText)}</p>`;
        }
        if (detail.company_information.website) {
            html += `<p style="margin-top:10px;"><strong>Website:</strong> <a href="${escapeHTML(detail.company_information.website)}" target="_blank">${escapeHTML(detail.company_information.website)}</a></p>`;
        }
        html += `</div></div>`;
    }

    // ── Contact Details ──
    if (detail?.contact_details && Object.keys(detail.contact_details).length) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Contact Details</div>
            <div class="contact-grid">`;
        for (const [key, value] of Object.entries(detail.contact_details)) {
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            html += `<div class="contact-item"><strong>${escapeHTML(label)}</strong><br>${escapeHTML(value)}</div>`;
        }
        html += `</div></div>`;
    }

    // ── Pre Requirements ──
    if (detail?.pre_requirements && detail.pre_requirements.requirements && detail.pre_requirements.requirements.length) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Requirements & Notes</div>
            <div class="detail-text-block">`;
        for (const req of detail.pre_requirements.requirements) {
            html += `• ${escapeHTML(req)}\n\n`;
        }
        if (detail.pre_requirements.links && detail.pre_requirements.links.length) {
            html += `\n<strong>Important Links:</strong>\n`;
            for (const link of detail.pre_requirements.links) {
                html += `<a href="${escapeHTML(link)}" target="_blank" style="color:var(--accent2);">${escapeHTML(link)}</a>\n`;
            }
        }
        html += `</div></div>`;
    }

    return html;
}

function formatJobText(text) {
    if (!text) return '';
    // Split on ** delimiters to create visual structure
    let formatted = escapeHTML(text);
    formatted = formatted.replace(/\*\*/g, '\n• ');
    // Clean up leading bullet if it starts with one
    formatted = formatted.replace(/^\n• /, '');
    return formatted;
}

// --- Recommendation System Engine ---

// Clean stop-words
const STOP_WORDS = new Set([
    "and", "or", "in", "of", "to", "for", "a", "an", "the", "with", "based", 
    "on", "specific", "skills", "good", "strong", "required", "knowledge", 
    "skills:", "role", "designation", "about", "key", "responsibilities", 
    "must", "have", "be", "we", "are", "looking", "candidate", "is", "at", 
    "as", "by", "from", "it", "our", "you", "your", "their", "this", "that",
    "will", "be", "notified", "later", "mandatory", "all", "rounds", 
    "documents", "required", "carry", "copies", "resume", "academic", "certificates", 
    "passport", "photos", "formal", "dress", "code", "indiscipline", "misconduct",
    "cheating", "during", "virtual", "physical", "placement", "drives", "university", 
    "policies", "reporting", "schedule", "separately", "announced", "through", "ums", 
    "registration", "request", "after", "lapse", "deadline", "coordinator", "tpc",
    "training", "office", "cell", "recruiter", "recruiters", "selection", "process"
]);

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function parseSalaryValue(salaryStr) {
    if (!salaryStr) return 0;
    const lpaMatch = salaryStr.match(/(\d+(?:\.\d+)?)\s*LPA/i);
    if (lpaMatch) {
        return parseFloat(lpaMatch[1]);
    }
    const pmMatch = salaryStr.match(/(?:Rs\.?\s*)?(\d{4,6})\s*(?:PM|month)/i);
    if (pmMatch) {
        return (parseFloat(pmMatch[1]) * 12) / 100000;
    }
    const numericMatch = salaryStr.replace(/,/g, '').match(/(\d{5,7})/);
    if (numericMatch) {
        return parseFloat(numericMatch[1]) / 100000;
    }
    return 0;
}

function recordView(companyName) {
    try {
        let viewed = JSON.parse(localStorage.getItem('tracker_viewed_companies') || '[]');
        viewed = viewed.filter(c => c !== companyName);
        viewed.push(companyName);
        if (viewed.length > 30) viewed.shift();
        localStorage.setItem('tracker_viewed_companies', JSON.stringify(viewed));
    } catch (e) {
        console.error('Failed to record view:', e);
    }
}

// Compute IDF map over the entire detailed drives corpus
function computeIDFMap(detailedDrives) {
    const N = detailedDrives.length;
    if (N === 0) return {};
    const df = {};
    detailedDrives.forEach(nd => {
        const text = `${nd.role} ${nd.full_title} ${nd.job_profile?.full_text || ''} ${nd.job_profile?.skills?.join(' ') || ''}`;
        const tokens = tokenize(text);
        const uniqueTokens = new Set(tokens);
        uniqueTokens.forEach(t => {
            df[t] = (df[t] || 0) + 1;
        });
    });
    const idfMap = {};
    for (const t in df) {
        // If a word appears in more than 70% of documents, it's boilerplate
        if (df[t] >= N * 0.70) {
            idfMap[t] = 0;
        } else {
            idfMap[t] = Math.log(N / df[t]);
        }
    }
    return idfMap;
}

// Get TF-IDF vector for a text
function getTFIDFVector(text, idfMap) {
    const tokens = tokenize(text);
    const termCounts = {};
    tokens.forEach(t => {
        termCounts[t] = (termCounts[t] || 0) + 1;
    });
    const totalTerms = tokens.length;
    const vector = {};
    for (const t in termCounts) {
        const tf = termCounts[t] / totalTerms;
        const idf = idfMap[t] || 0;
        vector[t] = tf * idf;
    }
    return vector;
}

// Classify drive career track
function getJobDomain(detail) {
    if (!detail) return 'OPERATIONS_MGMT';
    const text = ((detail.role || '') + ' ' + (detail.full_title || '') + ' ' + (detail.job_profile?.skills?.join(' ') || '')).toLowerCase();
    
    const techKeywords = ['developer', 'programmer', 'engineer', 'software', 'java', 'frontend', 'backend', 'full stack', 'fullstack', 'web', 'coding', 'c++', 'c#', 'dotnet', 'php', 'cloud', 'aws', 'devops', 'testing', 'qa', 'system analyst', 'node', 'react', 'javascript', 'html', 'css', 'git'];
    const dataKeywords = ['data', 'analyst', 'analytics', 'ai', 'ml', 'machine learning', 'sql', 'python', 'excel', 'tableau', 'power bi', 'powerbi', 'statistics', 'deep learning', 'nlp', 'database', 'r-programming'];
    const opsKeywords = ['operations', 'management', 'manager', 'sales', 'marketing', 'business development', 'bde', 'associate', 'consultant', 'hr', 'human resources', 'recruiter', 'support', 'customer success', 'executive', 'calling', 'finance', 'telecaller'];

    const countMatches = (keywords) => {
        let count = 0;
        keywords.forEach(k => {
            const escaped = k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i');
            if (regex.test(text)) {
                count++;
            }
        });
        return count;
    };

    const techCount = countMatches(techKeywords);
    const dataCount = countMatches(dataKeywords);
    const opsCount = countMatches(opsKeywords);

    if (techCount >= dataCount && techCount >= opsCount) return 'TECHNICAL';
    if (dataCount >= techCount && dataCount >= opsCount) return 'DATA_AI';
    return 'OPERATIONS_MGMT';
}

function getRecommendations(drives, detailedDrives) {
    // Determine user profile of viewed/registered drives
    let viewedCompanies = [];
    try {
        viewedCompanies = JSON.parse(localStorage.getItem('tracker_viewed_companies') || '[]');
    } catch(e) {}

    const registeredCompanies = new Set();
    drives.forEach(d => {
        const reg = (d.Registered || '').toLowerCase();
        const isReg = reg.includes('yes') || reg.includes('cancel');
        if (isReg) {
            registeredCompanies.add(d.Company.trim().toUpperCase());
        }
    });

    // 1. Build profile of interests
    const idfMap = computeIDFMap(detailedDrives);
    const profileVector = {};
    const userTracks = { TECHNICAL: 0, DATA_AI: 0, OPERATIONS_MGMT: 0 };
    let totalInterests = 0;

    detailedDrives.forEach(nd => {
        const companyUpper = nd.company.trim().toUpperCase();
        const isReg = registeredCompanies.has(companyUpper);
        const isViewed = viewedCompanies.includes(nd.company);

        if (isReg || isViewed) {
            const weight = isReg ? 3.0 : 1.0;
            totalInterests += weight;
            
            const domain = getJobDomain(nd);
            userTracks[domain] += weight;

            const docText = `${nd.role} ${nd.full_title} ${nd.job_profile?.full_text || ''} ${nd.job_profile?.skills?.join(' ') || ''}`;
            const docVector = getTFIDFVector(docText, idfMap);
            for (const t in docVector) {
                profileVector[t] = (profileVector[t] || 0) + weight * docVector[t];
            }
        }
    });

    const isProfileEmpty = totalInterests === 0;

    // Determine primary track
    let primaryTrack = 'TECHNICAL';
    let maxTrackWeight = 0;
    for (const track in userTracks) {
        if (userTracks[track] > maxTrackWeight) {
            maxTrackWeight = userTracks[track];
            primaryTrack = track;
        }
    }

    // 2. Score candidate drives (must be open and unregistered)
    const openUnregistered = drives.filter(d => {
        const reg = (d.Registered || '').toLowerCase();
        const isReg = reg.includes('yes') || reg.includes('cancel');
        const isOpen = getEffectiveStatus(d) === 'Open';
        return isOpen && !isReg;
    });

    const recommendations = [];

    openUnregistered.forEach(d => {
        const companyUpper = d.Company.trim().toUpperCase();
        const detail = detailedDrives.find(nd =>
            nd.company.trim().toUpperCase() === companyUpper ||
            nd.full_title.toUpperCase().includes(companyUpper)
        );

        let score = 0;
        const matchedSkills = [];
        const matchedKeywords = [];

        const salaryDesc = detail?.salary_package || '';
        const salaryLpa = parseSalaryValue(salaryDesc);

        if (isProfileEmpty) {
            // Cold start: sort by salary CTC
            score = salaryLpa * 10;
        } else {
            if (detail) {
                const docText = `${detail.role} ${detail.full_title} ${detail.job_profile?.full_text || ''} ${detail.job_profile?.skills?.join(' ') || ''}`;
                const docVector = getTFIDFVector(docText, idfMap);
                
                let tfidfSimilarity = 0;
                for (const t in docVector) {
                    if (profileVector[t]) {
                        tfidfSimilarity += profileVector[t] * docVector[t];
                        if (detail.job_profile?.skills?.map(s => s.toLowerCase()).includes(t)) {
                            matchedSkills.push(t);
                        } else {
                            matchedKeywords.push(t);
                        }
                    }
                }

                // Scale TF-IDF similarity to a reasonable number range
                score += tfidfSimilarity * 1000;

                // Career track match bonus
                const candTrack = getJobDomain(detail);
                if (candTrack === primaryTrack && maxTrackWeight > 0) {
                    // 1.5x multiplier boost for domain matching primary track
                    score *= 1.5;
                    // Add flat preference weight boost
                    score += userTracks[candTrack] * 5;
                } else if (userTracks[candTrack] > 0) {
                    score += userTracks[candTrack] * 3;
                }
            }
            
            // Salary CTC Boost
            score += Math.min(salaryLpa * 0.5, 5);
        }

        if (score > 0 || isProfileEmpty) {
            recommendations.push({
                drive: d,
                detail: detail,
                score: score,
                matchedSkills: matchedSkills,
                matchedKeywords: matchedKeywords,
                salaryLpa: salaryLpa
            });
        }
    });

    recommendations.sort((a, b) => b.score - a.score);

    return {
        list: recommendations.slice(0, 3),
        isFallback: isProfileEmpty
    };
}

// --- Dashboard ---
async function loadDashboard() {
    const drives = await api.getDrives() || [];
    // Pre-cache new drives for detail panel
    cachedNewDrives = await api.getNewDrives() || [];

    let open = 0, registered = 0, approaching = 0, closingSoon = 0;
    const now = Date.now();
    const alertCards = [];
    const openCards = [];

    for (const d of drives) {
        const reg = (d.Registered || '').toLowerCase();
        const isReg = reg.includes('yes') || reg.includes('cancel');
        const isOpen = getEffectiveStatus(d) === 'Open';
        const regDt = parseDate(d['Register By']);
        const driveDt = parseDate(d['Drive Date']);

        if (isOpen) open++;
        if (isReg) registered++;

        // Approaching: registered + drive date within 72h
        if (isReg && driveDt && driveDt > now && (driveDt - now) < 72 * 3600000) {
            approaching++;
            alertCards.push({ ...d, alertType: 'approaching' });
        }

        // Closing soon: not registered + open + deadline within 48h
        if (!isReg && isOpen && regDt && regDt > now && (regDt - now) < 48 * 3600000) {
            closingSoon++;
            alertCards.push({ ...d, alertType: 'closing' });
        }

        if (isOpen && regDt && regDt > now) {
            openCards.push(d);
        }
    }

    // Stats
    document.getElementById('statsRow').innerHTML = `
        <div class="stat-card green"><div class="label">Open</div><div class="value">${open}</div></div>
        <div class="stat-card blue"><div class="label">Registered</div><div class="value">${registered}</div></div>
        <div class="stat-card orange"><div class="label">Closing Soon</div><div class="value">${closingSoon}</div></div>
        <div class="stat-card red"><div class="label">Approaching</div><div class="value">${approaching}</div></div>
    `;

    // Alert cards (Urgent Alerts)
    const alertCardsHTML = alertCards.map(d => {
        const type = d.alertType === 'approaching' ? 'approaching' : 'closing';
        const label = d.alertType === 'approaching' ? 'DRIVE APPROACHING' : 'CLOSING SOON';
        const dateField = d.alertType === 'approaching' ? d['Drive Date'] : d['Register By'];
        return `<div class="drive-card" data-company="${escapeHTML(d.Company)}">
            <div class="company">${escapeHTML(d.Company)} <span class="badge ${type}">${label}</span></div>
            <div class="meta">
                <strong>Date:</strong> ${escapeHTML(dateField)} (${countdown(dateField)})<br>
                <strong>Status:</strong> ${escapeHTML(getEffectiveStatus(d))}
            </div>
        </div>`;
    });

    // Get recommendations
    const { list: recommendedList, isFallback } = getRecommendations(drives, cachedNewDrives);

    const recommendationCardsHTML = recommendedList.map(item => {
        const d = item.drive;
        const detail = item.detail;
        
        let matchBadgeHtml = '';
        if (isFallback) {
            matchBadgeHtml = `<span class="badge match-high">Featured</span>`;
        } else {
            if (item.score >= 30) {
                matchBadgeHtml = `<span class="badge match-high">Best Match</span>`;
            } else if (item.score >= 10) {
                matchBadgeHtml = `<span class="badge match-med">High Fit</span>`;
            } else {
                matchBadgeHtml = `<span class="badge match">Good Fit</span>`;
            }
        }

        // Build feature match display
        let tagsHtml = '';
        if (!isFallback) {
            const displayTags = [];
            if (item.matchedSkills.length > 0) {
                item.matchedSkills.slice(0, 2).forEach(s => {
                    displayTags.push(`<span class="recommend-tag">Skill: ${escapeHTML(s)}</span>`);
                });
            }
            if (item.matchedKeywords.length > 0 && displayTags.length < 3) {
                item.matchedKeywords.slice(0, 2).forEach(k => {
                    if (k.length > 3) {
                        displayTags.push(`<span class="recommend-tag">${escapeHTML(k)}</span>`);
                    }
                });
            }
            if (displayTags.length > 0) {
                tagsHtml = `<div class="recommend-features">${displayTags.join('')}</div>`;
            }
        } else if (detail?.salary_package) {
            tagsHtml = `<div class="recommend-features"><span class="recommend-tag" style="color:var(--green)">${escapeHTML(detail.salary_package.slice(0, 35))}${detail.salary_package.length > 35 ? '...' : ''}</span></div>`;
        }

        const roleTitle = detail?.role || 'Job Opportunity';

        return `
            <div class="drive-card" data-company="${escapeHTML(d.Company)}">
                <div class="company" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${escapeHTML(d.Company)}</span>
                    ${matchBadgeHtml}
                </div>
                <div class="meta" style="margin-top: 6px;">
                    <div style="font-weight: 600; color: var(--text); font-size:13px; margin-bottom:4px;">${escapeHTML(roleTitle)}</div>
                    <strong>Register By:</strong> ${escapeHTML(d['Register By'])} (${countdown(d['Register By'])})<br>
                    <strong>Salary:</strong> ${escapeHTML(detail?.salary_package || 'As per norms')}
                </div>
                ${tagsHtml}
            </div>
        `;
    });

    const combinedCardsHTML = [...alertCardsHTML, ...recommendationCardsHTML];
    if (combinedCardsHTML.length > 0) {
        document.getElementById('alertCards').innerHTML = combinedCardsHTML.join('');
    } else {
        document.getElementById('alertCards').innerHTML = '<div class="empty-state">No priority alerts or recommendations right now</div>';
    }

    // Open drive cards
    if (openCards.length) {
        document.getElementById('openCards').innerHTML = openCards.map(d => `
            <div class="drive-card" data-company="${escapeHTML(d.Company)}">
                <div class="company">${escapeHTML(d.Company)} ${statusBadge(getEffectiveStatus(d), d.Registered)}</div>
                <div class="meta">
                    <strong>Register By:</strong> ${escapeHTML(d['Register By'])} (${countdown(d['Register By'])})<br>
                    <strong>Drive Date:</strong> ${escapeHTML(d['Drive Date'])}
                </div>
            </div>
        `).join('');
    } else {
        document.getElementById('openCards').innerHTML = '<div class="empty-state">No open drives</div>';
    }

    // Attach click listeners to all drive cards
    attachCardListeners();
}

// --- All Drives Table ---
let currentFilter = 'all';
let currentDriveTypeFilter = 'all';

const filterBtns = document.querySelectorAll('.filter-btn');
filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        loadDrivesTable();
    });
});

document.getElementById('driveTypeFilter').addEventListener('change', (e) => {
    currentDriveTypeFilter = e.target.value;
    loadDrivesTable();
});

document.getElementById('driveSourceFilter')?.addEventListener('change', () => {
    loadDrivesTable();
});

async function loadDrivesTable() {
    let drives = [];
    const source = document.getElementById('driveSourceFilter')?.value || 'current';
    if (source === 'past') {
        drives = await api.getMyDrivesFull() || [];
    } else {
        drives = await api.getDrives() || [];
    }
    if (!cachedNewDrives) {
        cachedNewDrives = await api.getNewDrives() || [];
    }

    const select = document.getElementById('driveTypeFilter');
    if (select.options.length === 1 && cachedNewDrives.length > 0) {
        const types = new Set();
        cachedNewDrives.forEach(d => { if (d.drive_type) types.add(d.drive_type); });
        Array.from(types).sort().forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            select.appendChild(opt);
        });
    }

    const filtered = drives.filter(d => {
        // Status filter
        if (currentFilter !== 'all') {
            const reg = (d.Registered || '').toLowerCase();
            const isReg = reg.includes('yes') || reg.includes('cancel');
            const effStatus = getEffectiveStatus(d);
            if (currentFilter === 'open' && effStatus !== 'Open') return false;
            if (currentFilter === 'registered' && !isReg) return false;
            if (currentFilter === 'closed' && !effStatus.includes('Closed')) return false;
        }

        // Drive Type filter
        if (currentDriveTypeFilter !== 'all') {
            const normalizedName = (d.Company || '').trim().toUpperCase();
            const detail = cachedNewDrives.find(nd => 
                (nd.company || '').trim().toUpperCase() === normalizedName ||
                (nd.full_title || '').toUpperCase().includes(normalizedName)
            );
            if (!detail || detail.drive_type !== currentDriveTypeFilter) return false;
        }

        return true;
    });

    if (!filtered.length) {
        document.getElementById('drivesTable').innerHTML = '<div class="empty-state">No drives match this filter</div>';
        return;
    }

    let html = `<table>
        <thead><tr>
            <th>Company</th><th>Status</th><th>Register By</th><th>Drive Date</th><th>Time Left</th>
        </tr></thead><tbody>`;

    for (const d of filtered) {
        html += `<tr data-company="${escapeHTML(d.Company)}">
            <td><strong>${escapeHTML(d.Company)}</strong></td>
            <td>${statusBadge(getEffectiveStatus(d), d.Registered)}</td>
            <td>${escapeHTML(d['Register By'])}</td>
            <td>${escapeHTML(d['Drive Date'])}</td>
            <td>${countdown(d['Register By'])}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    document.getElementById('drivesTable').innerHTML = html;

    // Attach click listeners to table rows
    attachTableRowListeners();
}

// --- Click listeners ---
function attachCardListeners() {
    document.querySelectorAll('.drive-card[data-company]').forEach(card => {
        card.addEventListener('click', () => {
            const company = card.dataset.company;
            if (company) openCompanyDetail(company);
        });
    });
}

function attachTableRowListeners() {
    document.querySelectorAll('tr[data-company]').forEach(row => {
        row.addEventListener('click', () => {
            const company = row.dataset.company;
            if (company) openCompanyDetail(company);
        });
    });
}

// --- Settings ---
async function loadSettings() {
    const config = await api.loadConfig();
    const form = document.getElementById('settingsForm');
    
    // Ensure all inputs with name are cleared/loaded
    for (const input of form.querySelectorAll('input[name]')) {
        const key = input.name;
        const val = config[key];
        if (input.type === 'checkbox') {
            if (key === 'SILENT_STARTUP') {
                input.checked = val !== 'false';
            } else {
                input.checked = val === 'true';
            }
        } else {
            input.value = val || '';
        }
    }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {};
    const config = await api.loadConfig();
    // Keep existing keys
    Object.assign(data, config);
    // Override from form
    for (const input of form.querySelectorAll('input[name]')) {
        if (input.type === 'checkbox') {
            data[input.name] = input.checked ? 'true' : 'false';
        } else {
            data[input.name] = input.value;
        }
    }
    const result = await api.saveConfig(data);
    const status = document.getElementById('saveStatus');
    if (result.ok) {
        status.textContent = 'Saved';
        status.style.color = 'var(--green)';
        await checkCredentials();
    } else {
        status.textContent = 'Error: ' + result.error;
        status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
});

// --- Helper Functions for Stepper, Credentials & Startup ---
let hideStepperTimeout = null;

function handleStepperLogs(msg) {
    const stepperContainer = document.getElementById('stepperContainer');
    if (!stepperContainer) return;

    const stepConnect = document.getElementById('step-connect');
    const stepScrape = document.getElementById('step-scrape');
    const stepDetails = document.getElementById('step-details');
    const stepSort = document.getElementById('step-sort');

    function setStepState(stepEl, state) {
        if (!stepEl) return;
        stepEl.classList.remove('active', 'completed');
        if (state === 'active') {
            stepEl.classList.add('active');
        } else if (state === 'completed') {
            stepEl.classList.add('completed');
        }
    }

    if (msg.includes('[START]') || msg.includes('Connecting')) {
        if (hideStepperTimeout) clearTimeout(hideStepperTimeout);
        stepperContainer.style.display = 'block';
        setStepState(stepConnect, 'active');
        setStepState(stepScrape, 'idle');
        setStepState(stepDetails, 'idle');
        setStepState(stepSort, 'idle');
    }
    else if (msg.includes('Main page fetched') || msg.includes('discovered tab')) {
        setStepState(stepConnect, 'completed');
        setStepState(stepScrape, 'active');
    }
    else if (msg.includes('Fetching tab') || msg.includes('Found') || msg.includes('upcoming drives found')) {
        setStepState(stepConnect, 'completed');
        setStepState(stepScrape, 'completed');
        setStepState(stepDetails, 'active');
    }
    else if (msg.includes('Fetching drive details') || msg.includes('Parsed drives') || msg.includes('Saved drives.json') || msg.includes('runSorter')) {
        setStepState(stepConnect, 'completed');
        setStepState(stepScrape, 'completed');
        setStepState(stepDetails, 'completed');
        setStepState(stepSort, 'active');
    }
    else if (msg.includes('Pipeline complete') || msg.includes('[EXIT]') || msg.includes('[DONE]')) {
        setStepState(stepConnect, 'completed');
        setStepState(stepScrape, 'completed');
        setStepState(stepDetails, 'completed');
        setStepState(stepSort, 'completed');
        
        if (hideStepperTimeout) clearTimeout(hideStepperTimeout);
        hideStepperTimeout = setTimeout(() => {
            stepperContainer.style.display = 'none';
        }, 3000);
    }
    else if (msg.includes('[ERROR]') || msg.includes('[FAIL]')) {
        if (hideStepperTimeout) clearTimeout(hideStepperTimeout);
        hideStepperTimeout = setTimeout(() => {
            stepperContainer.style.display = 'none';
            setStepState(stepConnect, 'idle');
            setStepState(stepScrape, 'idle');
            setStepState(stepDetails, 'idle');
            setStepState(stepSort, 'idle');
        }, 3000);
    }
}

async function checkCredentials() {
    const config = await api.loadConfig();
    const banner = document.getElementById('credentialsWarning');
    if (banner) {
        if (!config || !config.USER_ID || !config.PASSWORD) {
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    }
}

async function initStartupCheckbox() {
    const chkStartup = document.getElementById('chkStartup');
    if (chkStartup) {
        try {
            const isEnabled = await api.getStartupState();
            chkStartup.checked = !!isEnabled;
            chkStartup.addEventListener('change', async (e) => {
                const result = await api.setStartupState(e.target.checked);
                chkStartup.checked = !!result;
            });
        } catch (err) {
            console.error('Error fetching startup settings:', err);
        }
    }
}

function updateLastSyncTime(time = null) {
    const syncTimeText = document.getElementById('syncTimeText');
    if (!syncTimeText) return;
    if (time) {
        localStorage.setItem('lastSyncTime', time);
    }
    const stored = localStorage.getItem('lastSyncTime');
    if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed)) {
            const date = new Date(parsed);
            const formatted = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            syncTimeText.textContent = `Synced: ${formatted}`;
        } else {
            syncTimeText.textContent = `Synced: ${stored}`;
        }
    } else {
        syncTimeText.textContent = `Synced: Never`;
    }
}

// Attach warning button action
const btnFix = document.getElementById('btnFixCredentials');
if (btnFix) {
    btnFix.addEventListener('click', () => {
        navBtns.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        const settingsBtn = Array.from(navBtns).find(btn => btn.dataset.view === 'settings');
        if (settingsBtn) settingsBtn.classList.add('active');
        const settingsView = document.getElementById('view-settings');
        if (settingsView) settingsView.classList.add('active');
        loadSettings();
    });
}

// --- Init ---
loadDashboard();
checkCredentials();
initStartupCheckbox();
updateLastSyncTime();
