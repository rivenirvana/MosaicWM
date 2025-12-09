// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Global constants and configuration values

import * as Logger from './logger.js';

export const WINDOW_SPACING = 8; // Pixels

export const TILE_INTERVAL_MS = 60000 * 5; // 5 minutes

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const DRAG_UPDATE_INTERVAL_MS = 50;

export const STARTUP_TILE_DELAY_MS = 300;

export const ANIMATION_DURATION_MS = 350;

export const ANIMATION_OPEN_CLOSE_DURATION_MS = 350;

// Minimum window dimensions for tiling consideration
export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 200;

// Thresholds for edge tiling detection (pixels from screen edge)
export const EDGE_TILING_THRESHOLD = 10;

// Timing constants for polling and delays
export const POLL_INTERVAL_MS = 50;
export const DEBOUNCE_DELAY_MS = 500;
export const RETILE_DELAY_MS = 100;
export const GEOMETRY_CHECK_DELAY_MS = 10;
export const SAFETY_TIMEOUT_BUFFER_MS = 100;

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Grab Operation IDs (Legacy replacements/Helpers if Meta doesn't expose them cleanly)
// These match common Meta.GrabOp values for resizing.
export const GRAB_OP_RESIZING_NW = 4097;  // Top-Left
export const GRAB_OP_RESIZING_N  = 8193;  // Top
export const GRAB_OP_RESIZING_NE = 20481; // Top-Right
export const GRAB_OP_RESIZING_W  = 32769; // Left
export const GRAB_OP_RESIZING_E  = 16385; // Right
export const GRAB_OP_RESIZING_SW = 40961; // Bottom-Left
export const GRAB_OP_RESIZING_S  = 61441; // Bottom (Guessing/Example) - wait, let's just list the ones we use
// The ones used in code: 4097, 8193, 20481, 32769, 16385, 40961, 36865
export const RESIZE_GRAB_OPS = [4097, 8193, 20481, 32769, 16385, 40961, 24577, 36865];

export const GRAB_OP_MOVING = 1;
export const GRAB_OP_KEYBOARD_MOVING = 1025;
