/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const WebSocket = require('ws');
const { URLSearchParams, URL } = require('url');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// --- Gemini Proxy Configuration ---
const externalApiBaseUrl = 'https://generativelanguage.googleapis.com';
const externalWsBaseUrl = 'wss://generativelanguage.googleapis.com';
const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;

// --- Supabase Client Initialization ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Warning: Supabase environment variables are not fully configured (need URL + key). Application API functionality will be disabled.");
}
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;
const registerAiRoutes = require('./aiRoutes');
const { assistantRouter } = require('./assistant');

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const BOARD_VISIBILITY_VALUES = new Set(['all', 'public', 'private', 'assigned']);
const createRequestId = () => Math.random().toString(36).slice(2, 10);
const isUuid = value => typeof value === 'string' && UUID_REGEX.test(value);
const normalizeUuidArray = values => {
    if (!Array.isArray(values)) return [];
    return values.filter(isUuid);
};
const validateBoardPostPayload = (body = {}) => {
    const errors = [];
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'all';
    const isTask = typeof body.is_task === 'boolean' ? body.is_task : false;
    const dueDate = body?.due_date ?? null;
    const assignees = body?.assignees;
    const createdBy = typeof body?.created_by === 'string' ? body.created_by : null;

    if (!title) errors.push('title is required');
    if (!content) errors.push('content is required');
    if (!BOARD_VISIBILITY_VALUES.has(visibility)) {
        errors.push(`visibility must be one of: ${Array.from(BOARD_VISIBILITY_VALUES).join(', ')}`);
    }
    if (assignees !== undefined && !Array.isArray(assignees)) {
        errors.push('assignees must be an array of UUID strings');
    }
    if (dueDate !== null && dueDate !== undefined) {
        const date = new Date(dueDate);
        if (Number.isNaN(date.getTime())) {
            errors.push('due_date must be a valid date string or null');
        }
    }
    if (createdBy && !isUuid(createdBy)) {
        errors.push('created_by must be a valid UUID');
    }

    return {
        errors,
        payload: {
            title,
            content,
            visibility,
            is_task: isTask,
            due_date: dueDate ?? null,
            assignees: normalizeUuidArray(assignees),
            created_by: createdBy && isUuid(createdBy) ? createdBy : null,
        },
    };
};
const getSupabaseStatus = error => {
    if (!error?.code) return 400;
    if (error.code === '23505') return 409;
    if (error.code === '23503') return 400;
    return 400;
};


const staticPath = path.join(__dirname, 'dist');
const publicPath = path.join(__dirname, 'public');

if (!apiKey) {
    // Only log an error, don't exit. The server will serve apps without proxy functionality
    console.error("Warning: GEMINI_API_KEY or API_KEY environment variable is not set! Proxy functionality will be disabled.");
}
else {
    console.log("API KEY FOUND (proxy will use this)")
}

// Limit body size to 50mb
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', 1 /* number of proxies between user and server */)
registerAiRoutes(app, supabase);
app.use('/api/assistant', assistantRouter);


// --- Google OAuth Setup ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_TIMEZONE = process.env.CALENDAR_TZ || 'Asia/Tokyo';
const DEFAULT_WEBHOOK_PATH = '/api/google/calendar/webhook';

const getGoogleOAuthClient = () => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        return null;
    }
    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
};

const getExistingRefreshToken = async (userId) => {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('user_google_tokens')
            .select('refresh_token')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) {
            console.error('[google/oauth] failed to load existing refresh_token', error);
            return null;
        }
        return data?.refresh_token || null;
    } catch (err) {
        console.error('[google/oauth] unexpected error while loading refresh_token', err);
        return null;
    }
};

const upsertGoogleToken = async ({ userId, tokens }) => {
    if (!supabase) {
        throw new Error('Supabase client not initialized');
    }
    const refreshToken = tokens.refresh_token || await getExistingRefreshToken(userId);
    if (!refreshToken) {
        throw new Error('Missing refresh_token from Google. Please re-authorize calendar access.');
    }
    const expiresAt =
        tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000)
                : null;
    const payload = {
        user_id: userId,
        provider: 'google',
        access_token: tokens.access_token,
        refresh_token: refreshToken,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        scope: tokens.scope || GOOGLE_SCOPES.join(' '),
        token_type: tokens.token_type || 'Bearer',
        id_token: tokens.id_token || null,
    };
    const { error } = await supabase
        .from('user_google_tokens')
        .upsert(payload, { onConflict: 'user_id' });
    if (error) {
        throw error;
    }
    return payload;
};

// --- Google OAuth Routes ---
app.post('/api/google/oauth/start', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id || req.query.user_id;
    const client = getGoogleOAuthClient();
    if (!client) {
        return res.status(503).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI.', requestId });
    }
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    try {
        const authUrl = client.generateAuthUrl({
            access_type: 'offline',
            scope: GOOGLE_SCOPES,
            prompt: 'consent',
            state: userId, // keep simple: state carries user id
        });
        return res.status(200).json({ authUrl, requestId });
    } catch (err) {
        console.error('[google/oauth/start] failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to generate auth url', requestId });
    }
});

// Status check (used by dashboard/settings)
app.post('/api/google/oauth/status', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id || req.query.user_id;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured', requestId });
    }
    try {
        const { data, error } = await supabase
            .from('user_google_tokens')
            .select('expires_at, scope')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        return res.status(200).json({
            connected: !!data,
            expires_at: data?.expires_at ?? null,
            scope: data?.scope ?? null,
            requestId,
        });
    } catch (err) {
        console.error('[google/oauth/status] failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to fetch status', requestId });
    }
});

// Disconnect (delete tokens)
app.post('/api/google/oauth/disconnect', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id || req.query.user_id;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured', requestId });
    }
    try {
        const { error } = await supabase
            .from('user_google_tokens')
            .delete()
            .eq('user_id', userId);
        if (error) throw error;
        return res.status(200).json({ success: true, requestId });
    } catch (err) {
        console.error('[google/oauth/disconnect] failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to disconnect', requestId });
    }
});

// --- System calendar (local) CRUD ---
app.get('/api/calendar/events', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.query?.user_id;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured', requestId });
    }
    try {
        const { data, error } = await supabase
            .from('calendar_events')
            .select('*')
            .eq('user_id', userId)
            .order('start_at', { ascending: true });
        if (error) throw error;
        return res.status(200).json({ events: data ?? [], requestId });
    } catch (err) {
        console.error('[calendar/events] list failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to fetch calendar events', requestId });
    }
});

app.post('/api/calendar/events', async (req, res) => {
    const requestId = createRequestId();
    const payload = req.body || {};
    const userId = payload.user_id;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    if (!payload.start_at) {
        return res.status(400).json({ error: 'start_at is required', requestId });
    }
    if (!payload.end_at) {
        payload.end_at = payload.start_at;
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured', requestId });
    }
    const record = {
        id: payload.id,
        user_id: userId,
        title: payload.title || '予定',
        description: payload.description ?? null,
        start_at: payload.start_at,
        end_at: payload.end_at,
        all_day: !!payload.all_day,
        source: payload.source || 'system',
        google_event_id: payload.google_event_id ?? null,
        updated_by_source: payload.updated_by_source || 'system',
        updated_at: new Date().toISOString(),
    };
    try {
        const { data, error } = await supabase
            .from('calendar_events')
            .upsert(record, { onConflict: 'id' })
            .select()
            .maybeSingle();
        if (error) throw error;
        return res.status(200).json({ event: data, requestId });
    } catch (err) {
        console.error('[calendar/events] upsert failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to save calendar event', requestId });
    }
});

app.delete('/api/calendar/events/:id', async (req, res) => {
    const requestId = createRequestId();
    const id = req.params?.id;
    const userId = req.query?.user_id;
    if (!id) {
        return res.status(400).json({ error: 'id is required', requestId });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured', requestId });
    }
    const query = supabase.from('calendar_events').delete().eq('id', id);
    if (isUuid(userId)) {
        query.eq('user_id', userId);
    }
    try {
        const { error } = await query;
        if (error) throw error;
        return res.status(200).json({ success: true, requestId });
    } catch (err) {
        console.error('[calendar/events] delete failed', { requestId, err });
        return res.status(500).json({ error: 'Failed to delete calendar event', requestId });
    }
});

// POST /api/google/calendar/sync - Sync ERP (DLY) -> Google Calendar for a user
app.post('/api/google/calendar/sync', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id;
    const timeMin = req.body?.timeMin;
    const timeMax = req.body?.timeMax;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    try {
        const summary = await syncErpToGoogle({ userId, timeMin, timeMax });
        return res.status(200).json({ message: 'Sync completed', summary, requestId });
    } catch (err) {
        console.error('[google/calendar/sync] failed', { requestId, err: err?.message, stack: err?.stack });
        return res.status(500).json({ error: err?.message || 'Sync failed', requestId });
    }
});

// OPTIONS/GET helpers for calendar sync endpoints (health checks / CORS preflight)
const calendarSyncOk = (res) => res.status(200).json({ ok: true });
app.options('/api/google/calendar/sync-system', (_, res) => calendarSyncOk(res));
app.options('/api/google/calendar/pull-system', (_, res) => calendarSyncOk(res));
app.get('/api/google/calendar/sync-system', (_, res) => calendarSyncOk(res));
app.get('/api/google/calendar/pull-system', (_, res) => calendarSyncOk(res));

// POST /api/google/calendar/sync-system - Sync system calendar_events -> Google
app.post('/api/google/calendar/sync-system', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id;
    const timeMin = req.body?.timeMin;
    const timeMax = req.body?.timeMax;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    try {
        const summary = await syncSystemToGoogle({ userId, timeMin, timeMax });
        return res.status(200).json({ message: 'System->Google sync completed', summary, requestId });
    } catch (err) {
        console.error('[google/calendar/sync-system] failed', { requestId, err: err?.message, stack: err?.stack });
        return res.status(500).json({ error: err?.message || 'System sync failed', requestId });
    }
});

// POST /api/google/calendar/pull-system - Sync Google -> system calendar_events
app.post('/api/google/calendar/pull-system', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id;
    const timeMin = req.body?.timeMin;
    const timeMax = req.body?.timeMax;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    try {
        const summary = await syncGoogleToSystem({ userId, timeMin, timeMax });
        return res.status(200).json({ message: 'Google->System sync completed', summary, requestId });
    } catch (err) {
        console.error('[google/calendar/pull-system] failed', { requestId, err: err?.message, stack: err?.stack });
        return res.status(500).json({ error: err?.message || 'Pull failed', requestId });
    }
});

// POST /api/google/calendar/watch - create webhook watch channel
app.post('/api/google/calendar/watch', async (req, res) => {
    const requestId = createRequestId();
    const userId = req.body?.user_id;
    const callbackUrl = req.body?.callback_url || (process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL}${DEFAULT_WEBHOOK_PATH}` : null);
    const ttlSeconds = req.body?.ttl;
    if (!isUuid(userId)) {
        return res.status(400).json({ error: 'user_id (UUID) is required', requestId });
    }
    if (!callbackUrl) {
        return res.status(400).json({ error: 'callback_url is required (or set PUBLIC_BASE_URL)', requestId });
    }
    try {
        const tokenRecord = await refreshGoogleTokenIfNeeded(userId);
        const accessToken = tokenRecord.access_token;
        const watch = await createGoogleWatch(accessToken, { callbackUrl, ttlSeconds });
        return res.status(200).json({ message: 'Watch created', watch, requestId });
    } catch (err) {
        console.error('[google/calendar/watch] failed', { requestId, err: err?.message, stack: err?.stack });
        return res.status(500).json({ error: err?.message || 'Watch creation failed', requestId });
    }
});

// Webhook endpoint for Google Calendar push notifications
app.post(DEFAULT_WEBHOOK_PATH, async (req, res) => {
    // Google does not require a specific response body; 200 is enough.
    // For now、詳細処理は未実装（Google→ERPの差分反映は別タスク）
    const resourceState = req.headers['x-goog-resource-state'];
    const channelId = req.headers['x-goog-channel-id'];
    const messageNumber = req.headers['x-goog-message-number'];
    console.log('[google/calendar/webhook]', { resourceState, channelId, messageNumber });
    res.status(200).send('ok');
});

app.get('/api/google/oauth/callback', async (req, res) => {
    const requestId = createRequestId();
    const client = getGoogleOAuthClient();
    if (!client) {
        return res.status(503).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI.', requestId });
    }
    const code = req.query.code;
    const rawState = req.query.state;
    const parseState = (state) => {
        if (!state) return { userId: null, returnTo: null };
        if (typeof state === 'string' && isUuid(state)) return { userId: state, returnTo: null };
        if (typeof state !== 'string') return { userId: null, returnTo: null };
        try {
            const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
            const userId = typeof decoded?.user_id === 'string' && isUuid(decoded.user_id)
                ? decoded.user_id
                : (typeof decoded?.userId === 'string' && isUuid(decoded.userId) ? decoded.userId : null);
            const returnToRaw = decoded?.return_to ?? decoded?.returnTo ?? null;
            const returnTo = typeof returnToRaw === 'string' ? returnToRaw : null;
            return { userId, returnTo };
        } catch {
            return { userId: null, returnTo: null };
        }
    };
    const parsed = parseState(rawState);
    // user id is expected either in state or query param
    const userId = req.query.user_id || parsed.userId || null;
    const redirectBase = (() => {
        const candidate = parsed.returnTo || process.env.PUBLIC_BASE_URL;
        if (typeof candidate === 'string' && candidate) return candidate.replace(/\/+$/, '');
        return 'https://erp.b-p.co.jp';
    })();
    const redirectOk = `${redirectBase}/settings?google_calendar=ok`;
    const redirectNg = `${redirectBase}/settings?google_calendar=error`;

    if (!code || !isUuid(userId)) {
        return res.redirect(302, `${redirectNg}&reason=missing_code_or_user`);
    }
    try {
        const { tokens } = await client.getToken(code);
        await upsertGoogleToken({ userId, tokens });
        return res.redirect(302, redirectOk);
    } catch (err) {
        console.error('[google/oauth/callback] token exchange failed', { requestId, err });
        return res.redirect(302, `${redirectNg}&reason=token_exchange_failed`);
    }
});

// --- Google Calendar Sync Helpers ---
const fetchGoogleTokenForUser = async (userId) => {
    if (!supabase) throw new Error('Supabase client not initialized');
    const { data, error } = await supabase.from('user_google_tokens').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data || null;
};

const refreshGoogleTokenIfNeeded = async (userId) => {
    const client = getGoogleOAuthClient();
    if (!client) throw new Error('Google OAuth is not configured');
    const record = await fetchGoogleTokenForUser(userId);
    if (!record) {
        throw new Error('No Google tokens found for this user. Authorize calendar first.');
    }
    const now = Date.now();
    const expiresAt = record.expires_at ? new Date(record.expires_at).getTime() : 0;
    if (expiresAt && expiresAt - now > 2 * 60 * 1000) {
        return record; // still valid
    }
    if (!record.refresh_token) {
        throw new Error('Missing refresh_token. Re-authorize calendar access.');
    }
    const tokenClient = getGoogleOAuthClient();
    tokenClient.setCredentials({
        access_token: record.access_token,
        refresh_token: record.refresh_token,
    });
    const { credentials } = await tokenClient.refreshAccessToken();
    await upsertGoogleToken({ userId, tokens: credentials });
    return {
        ...record,
        access_token: credentials.access_token,
        expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : record.expires_at,
    };
};

const fetchDlyApplications = async () => {
    if (!supabase) throw new Error('Supabase client not initialized');
    // Resolve code id once
    const { data: codeRow, error: codeErr } = await supabase
        .from('application_codes')
        .select('id')
        .eq('code', 'DLY')
        .single();
    if (codeErr) throw codeErr;
    const codeId = codeRow?.id;
    if (!codeId) throw new Error('application_code DLY not found');

    const { data, error } = await supabase
        .from('applications')
        .select('id, applicant_id, form_data, updated_at')
        .eq('application_code_id', codeId);
    if (error) throw error;
    return data || [];
};

const parseDateTime = (dateStr, timeStr) => {
    if (!dateStr || !timeStr) return null;
    const normalized = `${dateStr}T${timeStr.length === 5 ? timeStr : `${timeStr}`}`;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
};

const mapApplicationToGoogleEvent = (app, attendeeEmail) => {
    const reportDate = app.form_data?.reportDate;
    const startTime = app.form_data?.startTime;
    const endTime = app.form_data?.endTime;
    const startDateTime = parseDateTime(reportDate, startTime);
    const endDateTime = parseDateTime(reportDate, endTime);
    return {
        summary: app.form_data?.customerName || '日報',
        description: app.form_data?.activityContent || '',
        location: '',
        start: {
            dateTime: startDateTime || null,
            timeZone: DEFAULT_TIMEZONE,
        },
        end: {
            dateTime: endDateTime || null,
            timeZone: DEFAULT_TIMEZONE,
        },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
        extendedProperties: {
            private: {
                erp_event_id: app.id,
                erp_updated_at: app.updated_at || '',
            },
        },
    };
};

// Google Calendar list API requires timeMin when ordering by startTime.
// Derive a reasonable window if the caller didn't provide one to avoid 400s.
const resolveSyncWindow = (erpEvents, requestedTimeMin, requestedTimeMax) => {
    const normalizeIso = (value) => {
        if (!value) return null;
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : new Date(ms).toISOString();
    };

    const fallbackPastMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const fallbackFutureMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const bufferMs = 24 * 60 * 60 * 1000; // 1 day padding around ERP events
    const now = Date.now();

    const normalizedMin = normalizeIso(requestedTimeMin);
    const normalizedMax = normalizeIso(requestedTimeMax);

    let minTs = null;
    let maxTs = null;
    for (const app of erpEvents) {
        const startIso = parseDateTime(app.form_data?.reportDate, app.form_data?.startTime);
        const endIso = parseDateTime(app.form_data?.reportDate, app.form_data?.endTime);
        const startMs = startIso ? Date.parse(startIso) : NaN;
        const endMs = endIso ? Date.parse(endIso) : NaN;
        if (!Number.isNaN(startMs)) {
            minTs = minTs === null ? startMs : Math.min(minTs, startMs);
            maxTs = maxTs === null ? startMs : Math.max(maxTs, startMs);
        }
        if (!Number.isNaN(endMs)) {
            minTs = minTs === null ? endMs : Math.min(minTs, endMs);
            maxTs = maxTs === null ? endMs : Math.max(maxTs, endMs);
        }
    }

    const resolvedMin = normalizedMin
        || (minTs !== null ? new Date(minTs - bufferMs).toISOString() : new Date(now - fallbackPastMs).toISOString());
    const resolvedMax = normalizedMax
        || (maxTs !== null ? new Date(maxTs + bufferMs).toISOString() : new Date(now + fallbackFutureMs).toISOString());

    if (Date.parse(resolvedMax) < Date.parse(resolvedMin)) {
        return {
            timeMin: resolvedMin,
            timeMax: new Date(Date.parse(resolvedMin) + fallbackFutureMs).toISOString(),
        };
    }

    return { timeMin: resolvedMin, timeMax: resolvedMax };
};

const fetchApplicantEmail = async (userId) => {
    if (!userId || !supabase) return null;
    const { data, error } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .maybeSingle();
    if (error) return null;
    return data?.email || null;
};

const fetchGoogleEventsByErpId = async (accessToken, timeMin, timeMax) => {
    const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        showDeleted: 'true',
    });
    if (timeMin) {
        params.append('timeMin', timeMin);
    } else {
        // Safety net; resolveSyncWindow should already provide a value.
        params.append('timeMin', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    }
    if (timeMax) params.append('timeMax', timeMax);
    // Filter by private extended property if provided
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;
    const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const items = Array.isArray(data.items) ? data.items : [];
    const byErpId = new Map();
    for (const ev of items) {
        const erpId = ev?.extendedProperties?.private?.erp_event_id;
        if (erpId) byErpId.set(erpId, ev);
    }
    return byErpId;
};

const createGoogleEvent = async (accessToken, body) => {
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events`;
    const { data } = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data;
};

const updateGoogleEvent = async (accessToken, eventId, body) => {
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
    const { data } = await axios.patch(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data;
};

const deleteGoogleEvent = async (accessToken, eventId) => {
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
    await axios.delete(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
};

const createGoogleWatch = async (accessToken, { callbackUrl, channelId, ttlSeconds }) => {
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events/watch`;
    const body = {
        id: channelId || randomUUID(),
        type: 'webhook',
        address: callbackUrl,
    };
    if (ttlSeconds) {
        body.params = { ttl: ttlSeconds };
    }
    const { data } = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data;
};

const syncErpToGoogle = async ({ userId, timeMin, timeMax }) => {
    const tokenRecord = await refreshGoogleTokenIfNeeded(userId);
    const accessToken = tokenRecord.access_token;
    const erpEvents = await fetchDlyApplications();

    const { timeMin: resolvedTimeMin, timeMax: resolvedTimeMax } = resolveSyncWindow(erpEvents, timeMin, timeMax);
    const googleMap = await fetchGoogleEventsByErpId(accessToken, resolvedTimeMin, resolvedTimeMax);
    const summary = { created: 0, updated: 0, skipped: 0, missing: 0 };

    for (const app of erpEvents) {
        const attendeeEmail = await fetchApplicantEmail(app.applicant_id);
        const mapped = mapApplicationToGoogleEvent(app, attendeeEmail);
        if (!mapped.start?.dateTime || !mapped.end?.dateTime) {
            summary.skipped += 1;
            continue;
        }
        const existing = googleMap.get(app.id);
        if (!existing) {
            await createGoogleEvent(accessToken, mapped);
            summary.created += 1;
            continue;
        }
        const googleUpdated = existing.updated ? new Date(existing.updated).getTime() : 0;
        const erpUpdated = app.updated_at ? new Date(app.updated_at).getTime() : 0;
        if (erpUpdated && erpUpdated > googleUpdated + 1000) {
            await updateGoogleEvent(accessToken, existing.id, mapped);
            summary.updated += 1;
        } else {
            summary.skipped += 1;
        }
    }

    // Optionally delete Google events that no longer exist in ERP
    for (const [erpId, ev] of googleMap.entries()) {
        const exists = erpEvents.find((e) => e.id === erpId);
        if (!exists) {
            try {
                await deleteGoogleEvent(accessToken, ev.id);
                summary.missing += 1;
            } catch (err) {
                console.warn('[google sync] failed to delete missing event', erpId, err?.response?.data || err?.message);
            }
        }
    }

    return summary;
};

// --- System calendar <-> Google Calendar sync helpers ---
const listSystemCalendarEvents = async ({ userId, timeMin, timeMax }) => {
    if (!supabase) throw new Error('Supabase client not initialized');
    let query = supabase
        .from('calendar_events')
        .select('*')
        .eq('user_id', userId);
    if (timeMin) query = query.gte('start_at', timeMin);
    if (timeMax) query = query.lte('start_at', timeMax);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
};

const mapSystemEventToGoogle = (ev) => {
    const isAllDay = !!ev.all_day;
    const start = isAllDay
        ? { date: ev.start_at.slice(0, 10) }
        : { dateTime: ev.start_at, timeZone: DEFAULT_TIMEZONE };
    const end = isAllDay
        ? { date: ev.end_at.slice(0, 10) }
        : { dateTime: ev.end_at, timeZone: DEFAULT_TIMEZONE };
    return {
        summary: ev.title || '予定',
        description: ev.description || '',
        start,
        end,
        extendedProperties: {
            private: {
                calendar_event_id: ev.id,
                updated_by_source: ev.updated_by_source || 'system',
            },
        },
    };
};

const fetchGoogleEventsWindow = async (accessToken, { timeMin, timeMax }) => {
    const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
    });
    if (timeMin) params.set('timeMin', timeMin);
    if (timeMax) params.set('timeMax', timeMax);
    const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;
    const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data?.items || [];
};

const mapGoogleEventToSystem = (ev, userId) => {
    const isAllDay = !!ev.start?.date || !!ev.end?.date;
    const startIso = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00.000Z` : null);
    const endIso = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00.000Z` : null);
    const privateProps = ev.extendedProperties?.private || {};
    return {
        id: privateProps.calendar_event_id || null,
        user_id: userId,
        title: ev.summary || '(無題)',
        description: ev.description || '',
        start_at: startIso,
        end_at: endIso || startIso,
        all_day: isAllDay,
        source: 'google',
        google_event_id: ev.id,
        updated_by_source: 'google',
        updated_at: ev.updated || new Date().toISOString(),
    };
};

const upsertSystemEvents = async (events) => {
    if (!events.length) return [];
    const { data, error } = await supabase.from('calendar_events').upsert(events, { onConflict: 'id' }).select();
    if (error) throw error;
    return data || [];
};

const syncSystemToGoogle = async ({ userId, timeMin, timeMax }) => {
    const tokenRecord = await refreshGoogleTokenIfNeeded(userId);
    const accessToken = tokenRecord.access_token;
    const systemEvents = await listSystemCalendarEvents({ userId, timeMin, timeMax });
    const { timeMin: resolvedTimeMin, timeMax: resolvedTimeMax } = resolveSyncWindowForSystem(systemEvents, timeMin, timeMax);
    const googleEvents = await fetchGoogleEventsWindow(accessToken, { timeMin: resolvedTimeMin, timeMax: resolvedTimeMax });
    const googleById = new Map(googleEvents.map((g) => [g.id, g]));
    const summary = { created: 0, updated: 0, skipped: 0, deleted: 0 };
    const systemGoogleIds = new Set(systemEvents.filter((ev) => ev.google_event_id).map((ev) => ev.google_event_id));

    for (const ev of systemEvents) {
        const mapped = mapSystemEventToGoogle(ev);
        const googleId = ev.google_event_id;
        if (googleId && googleById.has(googleId)) {
            // compare timestamps
            const googleUpdated = new Date(googleById.get(googleId).updated || 0).getTime();
            const sysUpdated = ev.updated_at ? new Date(ev.updated_at).getTime() : 0;
            if (sysUpdated && sysUpdated > googleUpdated + 1000) {
                await updateGoogleEvent(accessToken, googleId, mapped);
                summary.updated += 1;
            } else {
                summary.skipped += 1;
            }
            continue;
        }
        const created = await createGoogleEvent(accessToken, mapped);
        // persist google_event_id
        await supabase.from('calendar_events').update({ google_event_id: created.id }).eq('id', ev.id);
        summary.created += 1;
    }

    // Delete Google events that point to system events no longer present
    for (const g of googleEvents) {
        const calId = g?.extendedProperties?.private?.calendar_event_id;
        if (calId && !systemEvents.find((ev) => ev.id === calId)) {
            try {
                await deleteGoogleEvent(accessToken, g.id);
                summary.deleted += 1;
            } catch (err) {
                console.warn('[google sync] failed to delete orphan Google event', g.id, err?.response?.data || err?.message);
            }
        }
    }
    return summary;
};

const syncGoogleToSystem = async ({ userId, timeMin, timeMax }) => {
    const tokenRecord = await refreshGoogleTokenIfNeeded(userId);
    const accessToken = tokenRecord.access_token;
    const { timeMin: resolvedTimeMin, timeMax: resolvedTimeMax } = resolveSyncWindowForSystem([], timeMin, timeMax);
    const googleEvents = await fetchGoogleEventsWindow(accessToken, { timeMin: resolvedTimeMin, timeMax: resolvedTimeMax });
    const systemExisting = await listSystemCalendarEvents({ userId, timeMin: resolvedTimeMin, timeMax: resolvedTimeMax });
    const systemByGoogleId = new Map(systemExisting.filter((ev) => ev.google_event_id).map((ev) => [ev.google_event_id, ev]));
    const systemById = new Map(systemExisting.map((ev) => [ev.id, ev]));
    const systemEvents = [];
    for (const ev of googleEvents) {
        const mapped = mapGoogleEventToSystem(ev, userId);
        if (!mapped.start_at) continue;
        systemEvents.push(mapped);
    }
    if (systemEvents.length) {
        await upsertSystemEvents(systemEvents);
    }
    // Delete system events whose google_event_id is missing on Google
    const googleIds = new Set(googleEvents.map((g) => g.id));
    const toDelete = [];
    for (const [gid, ev] of systemByGoogleId.entries()) {
        if (!googleIds.has(gid)) {
            toDelete.push(ev.id);
        }
    }
    if (toDelete.length) {
        await supabase.from('calendar_events').delete().in('id', toDelete);
    }
    return { pulled: systemEvents.length, deleted: toDelete.length };
};

const DEFAULT_SYNC_WINDOW_DAYS = 90;

const resolveSyncWindowForSystem = (events, requestedTimeMin, requestedTimeMax) => {
    const now = new Date();
    const defaultMin = new Date(now.getTime() - DEFAULT_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const defaultMax = new Date(now.getTime() + DEFAULT_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const normalizeIso = (value) => {
        if (!value) return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    return {
        timeMin: normalizeIso(requestedTimeMin) || normalizeIso(events?.[0]?.start_at) || defaultMin.toISOString(),
        timeMax: normalizeIso(requestedTimeMax) || defaultMax.toISOString(),
    };
};

// --- Application API Routes for Accounting ---

// GET /api/accounting/journal-drafts - Fetches all journal drafts
app.get('/api/accounting/journal-drafts', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized. Check server configuration.' });
    }
    try {
        const { data, error } = await supabase.rpc('get_journal_drafts');

        if (error) {
            console.error('Error from get_journal_drafts RPC:', error);
            // Pass along Supabase's error details if available
            return res.status(500).json({ error: 'Database RPC error', details: error.message });
        }

        res.status(200).json(data);
    } catch (err) {
        console.error('Unexpected error in /api/accounting/journal-drafts:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/accounting/applications/:id/create-journal - Creates a journal draft from an application
app.post('/api/accounting/applications/:id/create-journal', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized. Check server configuration.' });
    }
    try {
        const applicationId = req.params.id;
        // TODO: Implement proper user authentication and pass the actual user ID.
        // For now, p_user_id is passed as null.
        const { data: batchId, error } = await supabase.rpc('create_journal_from_application', {
            p_application_id: applicationId,
            p_user_id: null
        });

        if (error) {
            console.error('Error from create_journal_from_application RPC:', error);
            // Check for specific, user-facing errors from the RPC
            if (error.message.includes('Journal has already been created')) {
                return res.status(409).json({ error: 'Conflict', details: error.message });
            }
            if (error.message.includes('not found')) {
                return res.status(404).json({ error: 'Not Found', details: error.message });
            }
            return res.status(500).json({ error: 'Database RPC error', details: error.message });
        }

        res.status(201).json({ message: 'Journal draft created successfully', batchId });
    } catch (err) {
        console.error('Unexpected error in /api/accounting/applications/:id/create-journal:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/accounting/journal-batches/:id/approve - Approves (posts) a journal draft batch
app.post('/api/accounting/journal-batches/:id/approve', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized. Check server configuration.' });
    }
    try {
        const batchId = req.params.id;
        const { error } = await supabase.rpc('approve_journal_batch', {
            p_batch_id: batchId
        });

        if (error) {
            console.error('Error from approve_journal_batch RPC:', error);
            if (error.message.includes('not found')) {
                return res.status(404).json({ error: 'Not Found', details: error.message });
            }
            return res.status(500).json({ error: 'Database RPC error', details: error.message });
        }

        res.status(200).json({ message: 'Journal batch approved successfully' });
    } catch (err) {
        console.error('Unexpected error in /api/accounting/journal-batches/:id/approve:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Integrated Board API Routes ---

// GET /api/board/posts - Fetch posts for the current user
app.get('/api/board/posts', async (req, res) => {
    const requestId = createRequestId();
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized.', requestId });
    }
    try {
        const { data, error } = await supabase.rpc('get_user_posts', {
            p_user_id: req.query.user_id || null
        });

        if (error) {
            console.error('Error from get_user_posts RPC:', { requestId, error });
            const status = getSupabaseStatus(error);
            return res.status(status).json({ error: error.message, requestId });
        }

        res.status(200).json(data);
    } catch (err) {
        console.error('Error in /api/board/posts GET:', { requestId, err });
        res.status(500).json({ error: 'Internal server error', requestId });
    }
});

// POST /api/board/posts - Create a new post
app.post('/api/board/posts', async (req, res) => {
    const requestId = createRequestId();
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized.', requestId });
    }
    try {
        const { errors, payload } = validateBoardPostPayload(req.body || {});
        if (errors.length) {
            return res.status(400).json({ error: 'Invalid request body', details: errors, requestId });
        }

        const { data, error } = await supabase.rpc('create_post', {
            p_title: payload.title,
            p_content: payload.content,
            p_visibility: payload.visibility,
            p_is_task: payload.is_task,
            p_due_date: payload.due_date,
            p_assignees: payload.assignees,
            p_created_by: payload.created_by
        });

        if (error) {
            const status = getSupabaseStatus(error);
            console.error('Error from create_post RPC:', { requestId, code: error.code, message: error.message, details: error.details });
            return res.status(status).json({ error: error.message, code: error.code, requestId });
        }

        if (!data) {
            console.error('create_post RPC returned no data', { requestId });
            return res.status(500).json({ error: 'Post creation failed', requestId });
        }

        res.status(201).json({ message: 'Post created successfully', post_id: data, requestId });
    } catch (err) {
        console.error('Error in /api/board/posts POST:', { requestId, err });
        res.status(500).json({ error: 'Internal server error', requestId });
    }
});

// POST /api/board/posts/:id/comments - Add comment to post
app.post('/api/board/posts/:id/comments', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized.' });
    }
    try {
        const postId = req.params.id;
        const { content, user_id } = req.body;

        const { data, error } = await supabase.rpc('add_comment', {
            p_post_id: postId,
            p_content: content,
            p_user_id: user_id || null
        });

        if (error) {
            console.error('Error from add_comment RPC:', error);
            return res.status(500).json({ error: 'Database error', details: error.message });
        }

        res.status(201).json({ message: 'Comment added successfully', comment_id: data });
    } catch (err) {
        console.error('Error in /api/board/posts/:id/comments:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/board/posts/:id/complete - Mark task as completed
app.put('/api/board/posts/:id/complete', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Database client not initialized.' });
    }
    try {
        const postId = req.params.id;
        const { user_id } = req.body;

        const { error } = await supabase.rpc('complete_task', {
            p_post_id: postId,
            p_user_id: user_id || null
        });

        if (error) {
            console.error('Error from complete_task RPC:', error);
            return res.status(500).json({ error: 'Database error', details: error.message });
        }

        res.status(200).json({ message: 'Task completed successfully' });
    } catch (err) {
        console.error('Error in /api/board/posts/:id/complete:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// --- Gemini Proxy Logic ---

// Rate limiter for the proxy
const proxyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // Set ratelimit window at 15min (in ms)
    max: 100, // Limit each IP to 100 requests per window
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // no `X-RateLimit-*` headers
    handler: (req, res, next, options) => {
        console.warn(`Rate limit exceeded for IP: ${req.ip}. Path: ${req.path}`);
        res.status(options.statusCode).send(options.message);
    }
});

// Apply the rate limiter to the /api-proxy route before the main proxy logic
app.use('/api-proxy', proxyLimiter);

// Proxy route for Gemini API calls (HTTP)
app.use('/api-proxy', async (req, res, next) => {
    console.log(req.ip);
    // If the request is an upgrade request, it's for WebSockets, so pass to next middleware/handler
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return next(); // Pass to the WebSocket upgrade handler
    }

    // Handle OPTIONS request for CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust as needed for security
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Goog-Api-Key');
        res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight response for 1 day
        return res.sendStatus(200);
    }

    if (req.body) { // Only log body if it exists
        console.log("  Request Body (from frontend):", req.body);
    }
    try {
        // Construct the target URL by taking the part of the path after /api-proxy/
        const targetPath = req.url.startsWith('/') ? req.url.substring(1) : req.url;
        const apiUrl = `${externalApiBaseUrl}/${targetPath}`;
        console.log(`HTTP Proxy: Forwarding request to ${apiUrl}`);

        // Prepare headers for the outgoing request
        const outgoingHeaders = {};
        // Copy most headers from the incoming request
        for (const header in req.headers) {
            // Exclude host-specific headers and others that might cause issues upstream
            if (!['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(header.toLowerCase())) {
                outgoingHeaders[header] = req.headers[header];
            }
        }

        // Set the actual API key in the appropriate header
        outgoingHeaders['X-Goog-Api-Key'] = apiKey;

        // Set Content-Type from original request if present (for relevant methods)
        if (req.headers['content-type'] && ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
            outgoingHeaders['Content-Type'] = req.headers['content-type'];
        } else if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
            // Default Content-Type to application/json if no content type for post/put/patch
            outgoingHeaders['Content-Type'] = 'application/json';
        }

        // For GET or DELETE requests, ensure Content-Type is NOT sent,
        // even if the client erroneously included it.
        if (['GET', 'DELETE'].includes(req.method.toUpperCase())) {
            delete outgoingHeaders['Content-Type']; // Case-sensitive common practice
            delete outgoingHeaders['content-type']; // Just in case
        }

        // Ensure 'accept' is reasonable if not set
        if (!outgoingHeaders['accept']) {
            outgoingHeaders['accept'] = '*/*';
        }


        const axiosConfig = {
            method: req.method,
            url: apiUrl,
            headers: outgoingHeaders,
            responseType: 'stream',
            validateStatus: function (status) {
                return true; // Accept any status code, we'll pipe it through
            },
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
            axiosConfig.data = req.body;
        }
        // For GET, DELETE, etc., axiosConfig.data will remain undefined,
        // and axios will not send a request body.

        const apiResponse = await axios(axiosConfig);

        // Pass through response headers from Gemini API to the client
        for (const header in apiResponse.headers) {
            res.setHeader(header, apiResponse.headers[header]);
        }
        res.status(apiResponse.status);


        apiResponse.data.on('data', (chunk) => {
            res.write(chunk);
        });

        apiResponse.data.on('end', () => {
            res.end();
        });

        apiResponse.data.on('error', (err) => {
            console.error('Error during streaming data from target API:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Proxy error during streaming from target' });
            } else {
                // If headers already sent, we can't send a JSON error, just end the response.
                res.end();
            }
        });

    } catch (error) {
        console.error('Proxy error before request to target API:', error);
        if (!res.headersSent) {
            if (error.response) {
                const errorData = {
                    status: error.response.status,
                    message: error.response.data?.error?.message || 'Proxy error from upstream API',
                    details: error.response.data?.error?.details || null
                };
                res.status(error.response.status).json(errorData);
            } else {
                res.status(500).json({ error: 'Proxy setup error', message: error.message });
            }
        }
    }
});

const webSocketInterceptorScriptTag = `<script src="/public/websocket-interceptor.js" defer></script>`;

// Service Worker登録はキャッシュ事故回避のため無効化
const serviceWorkerRegistrationScript = '';

// Serve index.html or placeholder based on API key and file availability
app.get('/', (req, res) => {
    const placeholderPath = path.join(publicPath, 'placeholder.html');

    // Try to serve index.html
    console.log("LOG: Route '/' accessed. Attempting to serve index.html.");
    const indexPath = path.join(staticPath, 'index.html');

    fs.readFile(indexPath, 'utf8', (err, indexHtmlData) => {
        if (err) {
            // index.html not found or unreadable, serve the original placeholder
            console.log('LOG: index.html not found or unreadable. Falling back to original placeholder.');
            return res.sendFile(placeholderPath);
        }

        // If API key is not set, serve original HTML without injection
        if (!apiKey) {
            console.log("LOG: API key not set. Serving original index.html without script injections.");
            return res.sendFile(indexPath);
        }

        // index.html found and apiKey set, inject scripts
        console.log("LOG: index.html read successfully. Injecting scripts.");
        let injectedHtml = indexHtmlData;


        if (injectedHtml.includes('<head>')) {
            // Inject WebSocket interceptor first, then service worker script
            injectedHtml = injectedHtml.replace(
                '<head>',
                `<head>${webSocketInterceptorScriptTag}${serviceWorkerRegistrationScript}`
            );
            console.log("LOG: Scripts injected into <head>.");
        } else {
            console.warn("WARNING: <head> tag not found in index.html. Prepending scripts to the beginning of the file as a fallback.");
            injectedHtml = `${webSocketInterceptorScriptTag}${serviceWorkerRegistrationScript}${indexHtmlData}`;
        }
        res.send(injectedHtml);
    });
});

app.get('/service-worker.js', (req, res) => {
    return res.sendFile(path.join(publicPath, 'service-worker.js'));
});

app.use('/public', express.static(publicPath));
app.use(express.static(staticPath));

// Start the HTTP server
const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`HTTP proxy active on /api-proxy/**`);
    console.log(`WebSocket proxy active on /api-proxy/**`);
});

// Create WebSocket server and attach it to the HTTP server
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = requestUrl.pathname;

    if (pathname.startsWith('/api-proxy/')) {
        if (!apiKey) {
            console.error("WebSocket proxy: API key not configured. Closing connection.");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (clientWs) => {
            console.log('Client WebSocket connected to proxy for path:', pathname);

            const targetPathSegment = pathname.substring('/api-proxy'.length);
            const clientQuery = new URLSearchParams(requestUrl.search);
            clientQuery.set('key', apiKey);
            const targetGeminiWsUrl = `${externalWsBaseUrl}${targetPathSegment}?${clientQuery.toString()}`;
            console.log(`Attempting to connect to target WebSocket: ${targetGeminiWsUrl}`);

            const geminiWs = new WebSocket(targetGeminiWsUrl, {
                protocol: request.headers['sec-websocket-protocol'],
            });

            const messageQueue = [];

            geminiWs.on('open', () => {
                console.log('Proxy connected to Gemini WebSocket');
                // Send any queued messages
                while (messageQueue.length > 0) {
                    const message = messageQueue.shift();
                    if (geminiWs.readyState === WebSocket.OPEN) {
                        // console.log('Sending queued message from client -> Gemini');
                        geminiWs.send(message);
                    } else {
                        // Should not happen if we are in 'open' event, but good for safety
                        console.warn('Gemini WebSocket not open when trying to send queued message. Re-queuing.');
                        messageQueue.unshift(message); // Add it back to the front
                        break; // Stop processing queue for now
                    }
                }
            });

            geminiWs.on('message', (message) => {
                // console.log('Message from Gemini -> client');
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(message);
                }
            });

            geminiWs.on('close', (code, reason) => {
                console.log(`Gemini WebSocket closed: ${code} ${reason.toString()}`);
                if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                    clientWs.close(code, reason.toString());
                }
            });

            geminiWs.on('error', (error) => {
                console.error('Error on Gemini WebSocket connection:', error);
                if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                    clientWs.close(1011, 'Upstream WebSocket error');
                }
            });

            clientWs.on('message', (message) => {
                if (geminiWs.readyState === WebSocket.OPEN) {
                    // console.log('Message from client -> Gemini');
                    geminiWs.send(message);
                } else if (geminiWs.readyState === WebSocket.CONNECTING) {
                    // console.log('Queueing message from client -> Gemini (Gemini still connecting)');
                    messageQueue.push(message);
                } else {
                    console.warn('Client sent message but Gemini WebSocket is not open or connecting. Message dropped.');
                }
            });

            clientWs.on('close', (code, reason) => {
                console.log(`Client WebSocket closed: ${code} ${reason.toString()}`);
                if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
                    geminiWs.close(code, reason.toString());
                }
            });

            clientWs.on('error', (error) => {
                console.error('Error on client WebSocket connection:', error);
                if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
                    geminiWs.close(1011, 'Client WebSocket error');
                }
            });
        });
    } else {
        console.log(`WebSocket upgrade request for non-proxy path: ${pathname}. Closing connection.`);
        socket.destroy();
    }
});
