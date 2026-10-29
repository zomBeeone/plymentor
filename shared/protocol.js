// Constants shared by the app's window (app/) and its main process (desktop/).

export const APP_VERSION = '1.0.3';

// Bumped whenever window <-> coach host messages change incompatibly.
export const COACH_PROTOCOL = 2;

// The desktop app has one profile: its games database (in the window's storage) and the coach's settings and notes
// (%LOCALAPPDATA%\Plymentor\users\<id>\) use this id. Profile ids are UUIDs, so more profiles can come later.
export const LOCAL_PROFILE_ID = '00000000-0000-4000-8000-000000000001';

// The app's own address inside the desktop window (a privileged custom scheme, see desktop/main.js).
export const APP_ORIGIN = 'app://plymentor';
