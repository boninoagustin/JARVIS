import { google } from 'googleapis';
import { config } from '../config.js';
import fs from 'fs';

// Initialize Google Auth
let auth: any = null;

try {
    let serviceAccount;
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS;

    if (credPath && credPath.startsWith('{')) {
        serviceAccount = JSON.parse(credPath);
    } else if (credPath && fs.existsSync(credPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }

    if (serviceAccount) {
        auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: serviceAccount.client_email,
                private_key: serviceAccount.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        console.log('[CALENDAR] Google Calendar Auth initialized.');
    } else {
        console.warn('[CALENDAR] No valid Google credentials found.');
    }
} catch (err: any) {
    console.error('[CALENDAR] Error initializing Google Auth:', err.message);
}

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Creates an event in the primary calendar of the service account
 * Note: Service accounts have their own primary calendar, unless impersonating.
 * Sharing the service account calendar with the user is required to see these events.
 */
export async function createEvent(summary: string, description: string, startTimeIso: string, endTimeIso: string, userEmail?: string) {
    if (!auth) throw new Error("Google Auth is not initialized.");
    
    // We try to add the target user email as an attendee so it shows up on their calendar
    const attendees = userEmail ? [{ email: userEmail }] : [];

    const event = {
        summary,
        description,
        start: {
            dateTime: startTimeIso,
            timeZone: 'America/Argentina/Buenos_Aires', // Make configurable later
        },
        end: {
            dateTime: endTimeIso,
            timeZone: 'America/Argentina/Buenos_Aires',
        },
        attendees,
    };

    const res = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: event,
        sendUpdates: 'all', // Send email to attendees
    });

    return res.data;
}

/**
 * Lists upcoming events
 */
export async function getEvents(maxResults: number = 10) {
    if (!auth) throw new Error("Google Auth is not initialized.");

    const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
    });

    return res.data.items || [];
}
