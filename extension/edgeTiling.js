import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as tiling from './tiling.js';

/**
 * Edge Tiling Zones
 * 
 * 6-zone system:
 * - Left/Right Full: 50% width, 100% height
 * - Corners: 50% width, 50% height (TL, TR, BL, BR)
 */
export const TileZone = {
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7
};

// Module state for window states (pre-tile position/size)
const _windowStates = new Map(); // windowId -> { x, y, width, height, zone }

// Module state for edge tiling activity
let _isEdgeTilingActive = false;
let _activeEdgeTilingWindow = null;

// Module state for interactive resize
const _resizeListeners = new Map(); // windowId -> signalId
let _isResizing = false; // Flag to prevent recursive resize
const _previousSizes = new Map(); // windowId -> { width, height } for delta tracking

// Module state for auto-tiling dependencies
// Maps: dependentWindowId -> masterWindowId
const _autoTiledDependencies = new Map();

/**
 * Check if edge tiling is currently active (during drag)
 * @returns {boolean}
 */
export function isEdgeTilingActive() {
    return _isEdgeTilingActive;
}

/**
 * Get the window currently being edge-tiled
 * @returns {Meta.Window|null}
 */
export function getActiveEdgeTilingWindow() {
    return _activeEdgeTilingWindow;
}

/**
 * Set edge tiling active state
 * @param {boolean} active
 * @param {Meta.Window|null} window
 */
export function setEdgeTilingActive(active, window = null) {
    console.log(`[MOSAIC WM] Edge tiling state: ${_isEdgeTilingActive} -> ${active}, window: ${window ? window.get_id() : 'null'}`);
    _isEdgeTilingActive = active;
    _activeEdgeTilingWindow = window;
}

/**
 * Check if there are edge-tiled windows on a specific side
 * @param {Meta.Workspace} workspace
 * @param {string} side - 'left' or 'right'
 * @returns {boolean}
 */
function hasEdgeTiledWindows(workspace, side) {
    if (!workspace) return false;
    
    const windows = workspace.list_windows();
    for (const win of windows) {
        const state = _windowStates.get(win.get_id());
        // Only count windows that are CURRENTLY edge-tiled (zone !== NONE)
        if (!state || state.zone === TileZone.NONE || state.zone === TileZone.FULLSCREEN) continue;
        
        // Check if window is on the specified side
        if (side === 'left') {
            if (state.zone === TileZone.LEFT_FULL || 
                state.zone === TileZone.TOP_LEFT || 
                state.zone === TileZone.BOTTOM_LEFT) {
                return true;
            }
        } else if (side === 'right') {
            if (state.zone === TileZone.RIGHT_FULL || 
                state.zone === TileZone.TOP_RIGHT || 
                state.zone === TileZone.BOTTOM_RIGHT) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Detect which edge tiling zone the cursor is in
 * @param {number} cursorX - Cursor X coordinate
 * @param {number} cursorY - Cursor Y coordinate
 * @param {Object} workArea - Work area rectangle
 * @param {Meta.Workspace} workspace - Current workspace to check for existing windows
 * @returns {number} TileZone enum value
 */
export function detectZone(cursorX, cursorY, workArea, workspace) {
    const threshold = 10; // pixels from edge to trigger
    const thirdY = workArea.height / 3;
    
    // Top edge = fullscreen (like GNOME native behavior)
    if (cursorY < workArea.y + threshold) {
        return TileZone.FULLSCREEN;
    }
    
    // Left edge
    if (cursorX < workArea.x + threshold) {
        // Check if there are already windows on the left side
        const hasLeftWindows = hasEdgeTiledWindows(workspace, 'left');
        
        if (!hasLeftWindows) {
            // No windows on left = always return LEFT_FULL
            return TileZone.LEFT_FULL;
        }
        
        // Has windows = allow quarters
        const relY = cursorY - workArea.y;
        if (relY < thirdY) return TileZone.TOP_LEFT;
        if (relY > workArea.height - thirdY) return TileZone.BOTTOM_LEFT;
        return TileZone.LEFT_FULL;
    }
    
    // Right edge
    if (cursorX > workArea.x + workArea.width - threshold) {
        // Check if there are already windows on the right side
        const hasRightWindows = hasEdgeTiledWindows(workspace, 'right');
        
        if (!hasRightWindows) {
            // No windows on right = always return RIGHT_FULL
            return TileZone.RIGHT_FULL;
        }
        
        // Has windows = allow quarters
        const relY = cursorY - workArea.y;
        if (relY < thirdY) return TileZone.TOP_RIGHT;
        if (relY > workArea.height - thirdY) return TileZone.BOTTOM_RIGHT;
        return TileZone.RIGHT_FULL;
    }
    
    return TileZone.NONE;
}

/**
 * Get width of existing tile on the same side (LEFT or RIGHT)
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @param {string} side - 'LEFT' or 'RIGHT'
 * @returns {number|null} Width of existing window or null
 */
function getExistingSideWidth(workspace, monitor, side) {
    if (!workspace || monitor === undefined) return null;
    
    const workspaceWindows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor &&
        !w.is_hidden() &&
        w.get_window_type() === Meta.WindowType.NORMAL
    );
    
    // Find any window on the specified side
    let existing = null;
    for (const w of workspaceWindows) {
        const state = getWindowState(w);
        if (!state || !state.zone) continue;
        
        if (side === 'LEFT' && (
            state.zone === TileZone.LEFT_FULL ||
            state.zone === TileZone.TOP_LEFT ||
            state.zone === TileZone.BOTTOM_LEFT
        )) {
            existing = w;
            break;
        } else if (side === 'RIGHT' && (
            state.zone === TileZone.RIGHT_FULL ||
            state.zone === TileZone.TOP_RIGHT ||
            state.zone === TileZone.BOTTOM_RIGHT
        )) {
            existing = w;
            break;
        }
    }
    
    if (existing) {
        const frame = existing.get_frame_rect();
        return frame.width;
    }
    
    return null;
}

/**
 * Get height of existing quarter tile window
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @param {number} zone - TileZone to check
 * @returns {number|null} Height of existing window or null
 */
function getExistingQuarterHeight(workspace, monitor, zone) {
    if (!workspace || monitor === undefined) return null;
    
    const workspaceWindows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor &&
        !w.is_hidden() &&
        w.get_window_type() === Meta.WindowType.NORMAL
    );
    
    const existing = workspaceWindows.find(w => {
        const state = getWindowState(w);
        return state && state.zone === zone;
    });
    
    if (existing) {
        const frame = existing.get_frame_rect();
        return frame.height;
    }
    
    return null;
}

/**
 * Get rectangle for a tile zone
 * @param {number} zone - TileZone enum value
 * @param {Object} workArea - Work area rectangle
 * @param {Meta.Window} [windowToTile] - Optional: window being tiled (to check for existing tiled windows)
 * @returns {Object|null} Rectangle {x, y, width, height}
 */
export function getZoneRect(zone, workArea, windowToTile = null) {
    if (!workArea) return null;
    
    // Check if workspace has existing tiled window on opposite side
    let existingWidth = null;
    let existingX = null;
    
    if (windowToTile) {
        const workspace = windowToTile.get_workspace();
        const monitor = windowToTile.get_monitor();
        const workspaceWindows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor && 
            w.get_id() !== windowToTile.get_id() &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL
        );
        
        // Find existing tiled window on opposite side
        let oppositeZone = null;
        if (zone === TileZone.LEFT_FULL) {
            oppositeZone = TileZone.RIGHT_FULL;
        } else if (zone === TileZone.RIGHT_FULL) {
            oppositeZone = TileZone.LEFT_FULL;
        }
        
        if (oppositeZone) {
            const existingWindow = workspaceWindows.find(w => {
                const state = getWindowState(w);
                return state && state.zone === oppositeZone;
            });
            
            if (existingWindow) {
                const frame = existingWindow.get_frame_rect();
                existingWidth = frame.width;
                existingX = frame.x;
                console.log(`[MOSAIC WM] getZoneRect: Found existing tiled window with width ${existingWidth}px`);
            }
        }
    }
    
    const halfWidth = Math.floor(workArea.width / 2);
    const halfHeight = Math.floor(workArea.height / 2);
    
    switch(zone) {
        case TileZone.LEFT_FULL:
            return {
                x: workArea.x,
                y: workArea.y,
                width: existingWidth ? (workArea.width - existingWidth) : halfWidth,
                height: workArea.height
            };
            
        case TileZone.RIGHT_FULL:
            return {
                x: existingWidth ? (workArea.x + existingWidth) : (workArea.x + halfWidth),
                y: workArea.y,
                width: existingWidth ? (workArea.width - existingWidth) : (workArea.width - halfWidth),
                height: workArea.height
            };
            
        case TileZone.TOP_LEFT: {
            // Inherit width from existing LEFT side window
            const workspace = windowToTile?.get_workspace();
            const monitor = windowToTile?.get_monitor();
            const leftWidth = getExistingSideWidth(workspace, monitor, 'LEFT') || halfWidth;
            
            // Check for existing BOTTOM_LEFT to calculate height
            const bottomHeight = getExistingQuarterHeight(workspace, monitor, TileZone.BOTTOM_LEFT);
            
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: leftWidth, 
                height: bottomHeight ? (workArea.height - bottomHeight) : halfHeight 
            };
        }
            
        case TileZone.TOP_RIGHT: {
            // Inherit width from existing RIGHT side window
            const workspace = windowToTile?.get_workspace();
            const monitor = windowToTile?.get_monitor();
            const rightWidth = getExistingSideWidth(workspace, monitor, 'RIGHT') || halfWidth;
            
            // Check for existing BOTTOM_RIGHT to calculate height
            const bottomHeight = getExistingQuarterHeight(workspace, monitor, TileZone.BOTTOM_RIGHT);
            
            return { 
                x: workArea.x + workArea.width - rightWidth, 
                y: workArea.y, 
                width: rightWidth, 
                height: bottomHeight ? (workArea.height - bottomHeight) : halfHeight 
            };
        }
            
        case TileZone.BOTTOM_LEFT: {
            // Inherit width from existing LEFT side window
            const workspace = windowToTile?.get_workspace();
            const monitor = windowToTile?.get_monitor();
            const leftWidth = getExistingSideWidth(workspace, monitor, 'LEFT') || halfWidth;
            
            // Check for existing TOP_LEFT to calculate position and height
            const topHeight = getExistingQuarterHeight(workspace, monitor, TileZone.TOP_LEFT);
            
            return { 
                x: workArea.x, 
                y: topHeight ? (workArea.y + topHeight) : (workArea.y + halfHeight), 
                width: leftWidth, 
                height: topHeight ? (workArea.height - topHeight) : (workArea.height - halfHeight) 
            };
        }
            
        case TileZone.BOTTOM_RIGHT: {
            // Inherit width from existing RIGHT side window
            const workspace = windowToTile?.get_workspace();
            const monitor = windowToTile?.get_monitor();
            const rightWidth = getExistingSideWidth(workspace, monitor, 'RIGHT') || halfWidth;
            
            // Check for existing TOP_RIGHT to calculate position and height
            const topHeight = getExistingQuarterHeight(workspace, monitor, TileZone.TOP_RIGHT);
            
            return { 
                x: workArea.x + workArea.width - rightWidth, 
                y: topHeight ? (workArea.y + topHeight) : (workArea.y + halfHeight), 
                width: rightWidth, 
                height: topHeight ? (workArea.height - topHeight) : (workArea.height - halfHeight) 
            };
        }
            
        case TileZone.FULLSCREEN:
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: workArea.width, 
                height: workArea.height 
            };
        default:
            return null;
    }
}

/**
 * Save window's current state before tiling
 * @param {Meta.Window} window
 */
export function saveWindowState(window) {
    const winId = window.get_id();
    const existingState = _windowStates.get(winId);
    
    // Only save if window is NOT already edge-tiled
    // This preserves the original pre-tiling dimensions
    if (existingState && existingState.zone !== TileZone.NONE) {
        console.log(`[MOSAIC WM] Window ${winId} already has edge tile state, not overwriting`);
        return;
    }
    
    const frame = window.get_frame_rect();
    _windowStates.set(winId, {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        zone: TileZone.NONE
    });
    console.log(`[MOSAIC WM] Saved window ${winId} PRE-TILING state: ${frame.width}x${frame.height}`);
}

/**
 * Get saved window state
 * @param {Meta.Window} window
 * @returns {Object|undefined} Saved state or undefined
 */
export function getWindowState(window) {
    return _windowStates.get(window.get_id());
}

/**
 * Get all edge-tiled windows in a workspace
 * Replaces snap.getSnappedWindows()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Array<{window: Meta.Window, zone: number}>}
 */
export function getEdgeTiledWindows(workspace, monitor) {
    const windows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor && 
        !w.is_skip_taskbar() &&
        w.window_type === Meta.WindowType.NORMAL
    );
    
    return windows
        .map(w => ({window: w, state: getWindowState(w)}))
        .filter(({state}) => state && state.zone !== TileZone.NONE)
        .map(({window, state}) => ({window, zone: state.zone}));
}

/**
 * Get all non-edge-tiled windows in a workspace
 * Replaces snap.getNonSnappedWindows()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Array<Meta.Window>}
 */
export function getNonEdgeTiledWindows(workspace, monitor) {
    const windows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor && 
        !w.is_skip_taskbar() &&
        w.window_type === Meta.WindowType.NORMAL
    );
    
    return windows.filter(w => {
        const state = getWindowState(w);
        return !state || state.zone === TileZone.NONE;
    });
}

/**
 * Get the window currently occupying a specific zone
 * Used for DnD swap detection
 * @param {number} zone - TileZone enum value
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Meta.Window|null} Window in zone, or null if empty
 */
export function getWindowInZone(zone, workspace, monitor) {
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    
    for (const {window, zone: windowZone} of edgeTiledWindows) {
        if (windowZone === zone) {
            return window;
        }
    }
    
    return null;
}

/**
 * Calculate remaining workspace space after edge-tiled windows
 * Replaces snap.calculateRemainingSpace()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Object} Remaining space rectangle {x, y, width, height}
 */
export function calculateRemainingSpace(workspace, monitor) {
    const workArea = workspace.get_work_area_for_monitor(monitor);
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    
    if (edgeTiledWindows.length === 0) {
        return workArea;
    }
    
    // Check for left/right full tiles
    const hasLeftFull = edgeTiledWindows.some(w => w.zone === TileZone.LEFT_FULL);
    const hasRightFull = edgeTiledWindows.some(w => w.zone === TileZone.RIGHT_FULL);
    
    // Check for quarter tiles
    const hasLeftQuarters = edgeTiledWindows.some(w => 
        w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
    );
    const hasRightQuarters = edgeTiledWindows.some(w => 
        w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
    );
    
    const halfWidth = Math.floor(workArea.width / 2);
    
    // If left side is occupied (full or quarters), remaining space is on the right
    if (hasLeftFull || hasLeftQuarters) {
        return {
            x: workArea.x + halfWidth,
            y: workArea.y,
            width: workArea.width - halfWidth,
            height: workArea.height
        };
    }
    
    // If right side is occupied (full or quarters), remaining space is on the left
    if (hasRightFull || hasRightQuarters) {
        return {
            x: workArea.x,
            y: workArea.y,
            width: halfWidth,
            height: workArea.height
        };
    }
    
    // No full/quarter tiles, return full work area
    return workArea;
}

/**
 * Clear saved window state
 * @param {Meta.Window} window
 */
export function clearWindowState(window) {
    const winId = window.get_id();
    const state = _windowStates.get(winId);
    
    // If this was a quarter tile, expand the adjacent quarter to FULL
    if (state && state.zone && isQuarterZone(state.zone)) {
        console.log(`[MOSAIC WM] Quarter tile ${winId} being removed from zone ${state.zone}`);
        
        // Find the adjacent quarter tile (vertical pair)
        const adjacentZone = getAdjacentQuarterZone(state.zone);
        if (adjacentZone) {
            // Find window in adjacent zone
            const adjacentWindow = findWindowInZone(adjacentZone, window.get_workspace());
            
            if (adjacentWindow) {
                console.log(`[MOSAIC WM] Found adjacent quarter ${adjacentWindow.get_id()} in zone ${adjacentZone}, expanding to FULL`);
                
                // Determine which FULL zone to expand to
                const fullZone = getFullZoneFromQuarter(state.zone);
                
                // Expand adjacent window to FULL
                const workspace = window.get_workspace();
                const monitor = window.get_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                const fullRect = getZoneRect(fullZone, workArea, adjacentWindow);
                
                if (fullRect) {
                    adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);
                    
                    // Update state
                    const adjacentState = _windowStates.get(adjacentWindow.get_id());
                    if (adjacentState) {
                        adjacentState.zone = fullZone;
                    }
                    
                    console.log(`[MOSAIC WM] Expanded quarter to ${fullZone}: ${fullRect.width}x${fullRect.height}`);
                }
            }
        }
    }
    
    // Clean up auto-tile dependencies
    _autoTiledDependencies.forEach((masterId, dependentId) => {
        if (masterId === winId || dependentId === winId) {
            _autoTiledDependencies.delete(dependentId);
        }
    });
    
    _windowStates.delete(winId);
}

/**
 * Find window by ID across all workspaces
 * @param {number} windowId - Window ID to find
 * @returns {Meta.Window|null}
 */
function findWindowById(windowId) {
    const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
    return allWindows.find(w => w.get_id() === windowId) || null;
}

/**
 * Register an auto-tile dependency (for external use, e.g., dual-tiling)
 * @param {number} dependentId - ID of the dependent window
 * @param {number} masterId - ID of the master window
 */
export function registerAutoTileDependency(dependentId, masterId) {
    _autoTiledDependencies.set(dependentId, masterId);
    console.log(`[MOSAIC WM] Registered auto-tile dependency: ${dependentId} depends on ${masterId}`);
}

/**
 * Check if a zone is a quarter zone
 * @param {number} zone - TileZone value
 * @returns {boolean}
 */
export function isQuarterZone(zone) {
    return zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT ||
           zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
}

/**
 * Get the adjacent quarter zone (vertical pair)
 * @param {number} zone
 * @returns {number|null}
 */
function getAdjacentQuarterZone(zone) {
    switch (zone) {
        case TileZone.TOP_LEFT: return TileZone.BOTTOM_LEFT;
        case TileZone.BOTTOM_LEFT: return TileZone.TOP_LEFT;
        case TileZone.TOP_RIGHT: return TileZone.BOTTOM_RIGHT;
        case TileZone.BOTTOM_RIGHT: return TileZone.TOP_RIGHT;
        default: return null;
    }
}

/**
 * Get the FULL zone from a quarter zone
 * @param {number} quarterZone
 * @returns {number}
 */
function getFullZoneFromQuarter(quarterZone) {
    if (quarterZone === TileZone.TOP_LEFT || quarterZone === TileZone.BOTTOM_LEFT) {
        return TileZone.LEFT_FULL;
    } else {
        return TileZone.RIGHT_FULL;
    }
}

/**
 * Find window in a specific zone on a workspace
 * @param {number} zone
 * @param {Meta.Workspace} workspace
 * @returns {Meta.Window|null}
 */
function findWindowInZone(zone, workspace) {
    const windows = workspace.list_windows();
    
    for (const win of windows) {
        const state = _windowStates.get(win.get_id());
        if (state && state.zone === zone) {
            return win;
        }
    }
    
    return null;
}

/**
 * Check if window is currently edge-tiled
 * @param {Meta.Window} window
 * @returns {boolean}
 */
export function isEdgeTiled(window) {
    const state = _windowStates.get(window.get_id());
    return state && state.zone !== TileZone.NONE;
}

/**
 * Check if window can be resized to target dimensions
 * @param {Meta.Window} window
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {boolean}
 */
function canResize(window, targetWidth, targetHeight) {
    // Check window type - only normal windows can be tiled
    if (window.window_type !== 0) { // Meta.WindowType.NORMAL
        console.log(`[MOSAIC WM] Window type ${window.window_type} cannot be edge-tiled`);
        return false;
    }
    
    // Check if window allows resize
    if (window.allows_resize && !window.allows_resize()) {
        console.log(`[MOSAIC WM] Window does not allow resize`);
        return false;
    }
    
    return true;
}

/**
 * Apply edge tiling to a window
 * @param {Meta.Window} window
 * @param {number} zone - TileZone enum value
 * @param {Object} workArea - Work area rectangle
 * @param {boolean} skipOverflowCheck - If true, skip mosaic overflow check (for swaps)
 * @returns {boolean} Success
 */
export function applyTile(window, zone, workArea, skipOverflowCheck = false) {
    // Save current window state before tiling
    saveWindowState(window);
    
    const winId = window.get_id();
    
    // If this window is a dependent, manual retiling breaks the dependency
    if (_autoTiledDependencies.has(winId)) {
        console.log(`[MOSAIC WM] Manual retile breaks auto-tile dependency for ${winId}`);
        _autoTiledDependencies.delete(winId);
    }
    
    // Special case: fullscreen
    if (zone === TileZone.FULLSCREEN) {
        window.maximize(); // No arguments needed
        
        // Update state
        const state = _windowStates.get(window.get_id());
        if (state) {
            state.zone = zone;
        }
        
        console.log(`[MOSAIC WM] Maximized window ${window.get_id()}`);
        return true;
    }
    
    const rect = getZoneRect(zone, workArea, window);
    if (!rect) {
        console.log(`[MOSAIC WM] Invalid zone ${zone}`);
        return false;
    }
    
    // Check if window can be resized
    if (!canResize(window, rect.width, rect.height)) {
        return false;
    }
    
    // Check for FULL→QUARTER conversion
    const workspace = window.get_workspace();
    const monitor = window.get_monitor();
    let fullToQuarterConversion = null;
    
    if (zone === TileZone.BOTTOM_LEFT || zone === TileZone.TOP_LEFT) {
        // Check if LEFT_FULL exists
        const workspaceWindows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor &&
            w.get_id() !== window.get_id() &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL
        );
        
        const leftFullWindow = workspaceWindows.find(w => {
            const state = getWindowState(w);
            return state && state.zone === TileZone.LEFT_FULL;
        });
        
        if (leftFullWindow) {
            const newZone = (zone === TileZone.BOTTOM_LEFT) ? TileZone.TOP_LEFT : TileZone.BOTTOM_LEFT;
            fullToQuarterConversion = { window: leftFullWindow, newZone };
        }
    } else if (zone === TileZone.BOTTOM_RIGHT || zone === TileZone.TOP_RIGHT) {
        // Check if RIGHT_FULL exists
        const workspaceWindows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor &&
            w.get_id() !== window.get_id() &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL
        );
        
        const rightFullWindow = workspaceWindows.find(w => {
            const state = getWindowState(w);
            return state && state.zone === TileZone.RIGHT_FULL;
        });
        
        if (rightFullWindow) {
            const newZone = (zone === TileZone.BOTTOM_RIGHT) ? TileZone.TOP_RIGHT : TileZone.BOTTOM_RIGHT;
            fullToQuarterConversion = { window: rightFullWindow, newZone };
        }
    }
    
    // If conversion needed, just log and proceed
    let savedFullTileWidth = null;
    if (fullToQuarterConversion) {
        // Save the FULL tile width BEFORE applying the new quarter tile
        const fullFrame = fullToQuarterConversion.window.get_frame_rect();
        savedFullTileWidth = fullFrame.width;
        console.log(`[MOSAIC WM] Converting FULL tile ${fullToQuarterConversion.window.get_id()} to quarter zone ${fullToQuarterConversion.newZone}, preserving width=${savedFullTileWidth}px`);
    }
    
    // Unmaximize first (no arguments needed)
    window.unmaximize();
    
    // Apply tile using idle callback for reliability
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        
        // Note: Square corners feature deferred - requires GLSL shaders
        // See interactive_resize_task.md for future implementation
        
        // Setup resize listener for interactive resize
        setupResizeListener(window);
        
        // Update state
        const state = _windowStates.get(winId);
        if (state) {
            state.zone = zone;
        }
        
        console.log(`[MOSAIC WM] Applied edge tile zone ${zone} to window ${winId}`);
        
        // Apply conversion if needed
        if (fullToQuarterConversion && savedFullTileWidth) {
            // Use the saved width for both quarters
            const convertedRect = getZoneRect(fullToQuarterConversion.newZone, workArea, fullToQuarterConversion.window);
            
            // Override width with saved FULL tile width
            convertedRect.width = savedFullTileWidth;
            rect.width = savedFullTileWidth;
            
            // Recalculate x positions based on saved width
            if (fullToQuarterConversion.newZone === TileZone.TOP_LEFT || fullToQuarterConversion.newZone === TileZone.BOTTOM_LEFT) {
                convertedRect.x = workArea.x;
                rect.x = workArea.x;
            } else {
                convertedRect.x = workArea.x + workArea.width - savedFullTileWidth;
                rect.x = workArea.x + workArea.width - savedFullTileWidth;
            }
            
            // Calculate halfHeight for initial sizing
            const halfHeight = Math.floor(workArea.height / 2);
            
            // Apply conversion with halfHeight
            fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, convertedRect.y, convertedRect.width, halfHeight);
            
            // Apply new quarter with halfHeight
            window.move_resize_frame(false, rect.x, rect.y, rect.width, halfHeight);
            
            console.log(`[MOSAIC WM] Applied quarter tiles with halfHeight=${halfHeight}px, width=${savedFullTileWidth}px`);
            
            // Update converted window state IMMEDIATELY (before timeout)
            // This ensures getEdgeTiledWindows counts both quarters correctly
            const convertedState = _windowStates.get(fullToQuarterConversion.window.get_id());
            if (convertedState) {
                convertedState.zone = fullToQuarterConversion.newZone;
            }
            
            // Schedule adjustment after compositor processes the resize
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                // Check actual heights after compositor processed
                const actualConvertedFrame = fullToQuarterConversion.window.get_frame_rect();
                const actualNewFrame = window.get_frame_rect();
                
                console.log(`[MOSAIC WM] Post-resize check: converted=${actualConvertedFrame.height}px, new=${actualNewFrame.height}px, target=${halfHeight}px`);
                
                // If either didn't reach halfHeight, adjust the other to fill space
                if (actualConvertedFrame.height > halfHeight || actualNewFrame.height > halfHeight) {
                    if (zone === TileZone.BOTTOM_LEFT || zone === TileZone.BOTTOM_RIGHT) {
                        // New window is BOTTOM, adjust it to fill remaining space
                        const remainingHeight = workArea.height - actualConvertedFrame.height;
                        const newY = workArea.y + actualConvertedFrame.height;
                        window.move_resize_frame(false, rect.x, newY, rect.width, remainingHeight);
                        console.log(`[MOSAIC WM] Adjusted BOTTOM to ${remainingHeight}px at y=${newY}`);
                    } else {
                        // New window is TOP, adjust BOTTOM to fill remaining space
                        const remainingHeight = workArea.height - actualNewFrame.height;
                        const newY = workArea.y + actualNewFrame.height;
                        fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, newY, convertedRect.width, remainingHeight);
                        console.log(`[MOSAIC WM] Adjusted BOTTOM to ${remainingHeight}px at y=${newY}`);
                    }
                }
                
                // Re-tile mosaic after quarter conversion completes
                // This ensures mosaic windows reorganize into the remaining space
                import('./tiling.js').then(tiling => {
                    tiling.tileWorkspaceWindows(workspace, null, monitor, false);
                    console.log(`[MOSAIC WM] Re-tiled mosaic after quarter conversion`);
                });
                
                return GLib.SOURCE_REMOVE;
            });
            
            console.log(`[MOSAIC WM] Converted to ${convertedRect.width}x${convertedRect.height}, new quarter: ${rect.width}x${rect.height}`);
        }
        
        // Check for mosaic overflow after tiling (unless explicitly skipped for swaps)
        if (!skipOverflowCheck) {
            handleMosaicOverflow(window, zone);
        }
        
        return GLib.SOURCE_REMOVE;
    });
    
    return true;
}

/**
 * Remove edge tiling and restore window to previous state
 * @param {Meta.Window} window
 * @param {Function} callback - Optional callback to call after restoration completes
 */
export function removeTile(window, callback = null) {
    const winId = window.get_id();
    const savedState = _windowStates.get(winId);

    if (!savedState || savedState.zone === TileZone.NONE) {
        console.log(`[MOSAIC WM] removeTile: Window ${winId} is not edge-tiled`);
        if (callback) callback();
        return;
    }
    
    console.log(`[MOSAIC WM] removeTile: Removing tile from window ${winId}, zone=${savedState.zone}`);
    
    // Remove resize listener
    removeResizeListener(window);
    
    // Note: Square corners restoration deferred

    // Clear zone BEFORE restoring to prevent hasEdgeTiledWindows from detecting this window
    // Make a copy of the state to preserve dimensions
    const savedWidth = savedState.width;
    const savedHeight = savedState.height;
    const savedX = savedState.x;
    const savedY = savedState.y;
    
    console.log(`[MOSAIC WM] removeTile: Saved dimensions: ${savedWidth}x${savedHeight} at (${savedX}, ${savedY})`);
    
    // Check if this window has auto-tiled dependents
    _autoTiledDependencies.forEach((masterId, dependentId) => {
        if (masterId === winId) {
            console.log(`[MOSAIC WM] Master window ${winId} exiting - removing dependent ${dependentId}`);
            
            const dependent = findWindowById(dependentId);
            if (dependent) {
                // Remove dependent from tiling (will return to mosaic)
                removeTile(dependent);
            }
            
            // Clean up dependency
            _autoTiledDependencies.delete(dependentId);
        }
    });
    
    // If this was a quarter tile, expand the adjacent quarter to FULL
    if (isQuarterZone(savedState.zone)) {
        console.log(`[MOSAIC WM] Quarter tile ${winId} being removed from zone ${savedState.zone}`);
        
        // Find the adjacent quarter tile (vertical pair)
        const adjacentZone = getAdjacentQuarterZone(savedState.zone);
        if (adjacentZone) {
            // Find window in adjacent zone
            const adjacentWindow = findWindowInZone(adjacentZone, window.get_workspace());
            
            if (adjacentWindow) {
                console.log(`[MOSAIC WM] Found adjacent quarter ${adjacentWindow.get_id()} in zone ${adjacentZone}, expanding to FULL`);
                
                // Determine which FULL zone to expand to
                const fullZone = getFullZoneFromQuarter(savedState.zone);
                
                // Expand adjacent window to FULL
                const workspace = window.get_workspace();
                const monitor = window.get_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                const fullRect = getZoneRect(fullZone, workArea, adjacentWindow);
                
                if (fullRect) {
                    adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);
                    
                    // Update state
                    const adjacentState = _windowStates.get(adjacentWindow.get_id());
                    if (adjacentState) {
                        adjacentState.zone = fullZone;
                    }
                    
                    console.log(`[MOSAIC WM] Expanded quarter to ${fullZone}: ${fullRect.width}x${fullRect.height}`);
                }
            }
        }
    }
    
    savedState.zone = TileZone.NONE;
    
    // Get current window position before restoration
    const currentFrame = window.get_frame_rect();
    console.log(`[MOSAIC WM] removeTile: Current window position BEFORE restore: (${currentFrame.x}, ${currentFrame.y}), size: ${currentFrame.width}x${currentFrame.height}`);
    
    // Unmaximize first
    if (window.maximized_horizontally || window.maximized_vertically) {
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }
    
    // Restore to cursor position instead of saved position to avoid flicker
    // The saved position is often off-screen (where the window was when dragged to edge)
    // Restoring to cursor position provides smooth UX with no visible jump
    const [cursorX, cursorY] = global.get_pointer();
    const restoredX = cursorX - (savedWidth / 2);  // Center window on cursor
    const restoredY = cursorY - 20;  // Slightly below cursor (titlebar offset)
    
    console.log(`[MOSAIC WM] removeTile: Restoring to cursor position (${restoredX}, ${restoredY}) instead of saved (${savedX}, ${savedY})`);
    window.move_resize_frame(false, restoredX, restoredY, savedWidth, savedHeight);
    
    // Wait for the window manager to process the resize before calling callback
    // Using a timeout to ensure the window has actually been resized
    if (callback) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            // Check position after restoration
            const afterFrame = window.get_frame_rect();
            console.log(`[MOSAIC WM] removeTile: Window position AFTER restore: (${afterFrame.x}, ${afterFrame.y}), size: ${afterFrame.width}x${afterFrame.height}`);
            
            console.log(`[MOSAIC WM] removeTile: Calling callback after restoration`);
            callback();
            
            return GLib.SOURCE_REMOVE;
        });
    }
    
    console.log(`[MOSAIC WM] Removed edge tile from window ${window.get_id()}, restored to ${savedWidth}x${savedHeight}`);
}

/**
 * Handle mosaic overflow after edge tiling is applied
 * @param {Meta.Window} tiledWindow - Window that was just edge-tiled
 * @param {number} zone - Zone that was applied
 */
function handleMosaicOverflow(tiledWindow, zone) {
    // Only handle for full-width tiles (not quarters or fullscreen)
    if (zone !== TileZone.LEFT_FULL && zone !== TileZone.RIGHT_FULL) {
        return;
    }
    
    const workspace = tiledWindow.get_workspace();
    const monitor = tiledWindow.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Get remaining space after edge tiling
    const remainingSpace = calculateRemainingSpace(workspace, monitor);
    
    // Get non-edge-tiled windows (mosaic windows)
    const mosaicWindows = getNonEdgeTiledWindows(workspace, monitor);
    
    if (mosaicWindows.length === 0) {
        console.log('[MOSAIC WM] No mosaic windows - no overflow check needed');
        return;
    }
    
    console.log(`[MOSAIC WM] Checking mosaic overflow: ${mosaicWindows.length} mosaic windows, remaining space: ${remainingSpace.width}x${remainingSpace.height}`);
    
    // CASE 2: Single large window → auto-tile to opposite side
    if (mosaicWindows.length === 1) {
        const mosaicWindow = mosaicWindows[0];
        const frame = mosaicWindow.get_frame_rect();
        
        // Check if window is large enough to auto-tile (≥80% of remaining space)
        const widthThreshold = remainingSpace.width * 0.8;
        
        if (frame.width >= widthThreshold) {
            console.log(`[MOSAIC WM] Single large window (${frame.width}px ≥ ${widthThreshold}px) - auto-tiling to opposite side`);
            
            // Determine opposite zone
            const oppositeZone = (zone === TileZone.LEFT_FULL) 
                ? TileZone.RIGHT_FULL 
                : TileZone.LEFT_FULL;
            
            // Auto-tile the window (use timeout to avoid recursion)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                applyTile(mosaicWindow, oppositeZone, workArea);
                
                // Track this as an auto-tiled dependency
                const dependentId = mosaicWindow.get_id();
                const masterId = tiledWindow.get_id();
                _autoTiledDependencies.set(dependentId, masterId);
                console.log(`[MOSAIC WM] Tracked auto-tile dependency: ${dependentId} depends on ${masterId}`);
                
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
    }
    
    // CASE 1: Check if mosaic windows fit in remaining space
    // Create test descriptors for mosaic windows
    const testWindows = mosaicWindows.map((w, index) => {
        const frame = w.get_frame_rect();
        return {
            id: w.get_id(),
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            index: index
        };
    });
    
    // Use tiling algorithm to check if they fit
    // Note: We need to access the tile function directly
    // Since tiling is imported at module level, we can't call it here
    // Instead, use a simpler heuristic: check total area
    let totalMosaicArea = 0;
    for (const w of mosaicWindows) {
        const frame = w.get_frame_rect();
        totalMosaicArea += frame.width * frame.height;
    }
    
    const remainingArea = remainingSpace.width * remainingSpace.height;
    const areaThreshold = remainingArea * 0.7; // 70% threshold
    
    if (totalMosaicArea > areaThreshold) {
        console.log(`[MOSAIC WM] Mosaic windows don't fit (${totalMosaicArea}px² > ${areaThreshold}px²) - moving all to SAME new workspace`);
        
        // Create ONE new workspace for all mosaic windows
        import('./windowing.js').then(windowing => {
            const workspaceManager = global.workspace_manager;
            const currentIndex = workspace.index();
            const nWorkspaces = workspaceManager.get_n_workspaces();
            
            // Create new workspace after current one
            const newWorkspace = workspaceManager.append_new_workspace(false, global.get_current_time());
            
            console.log(`[MOSAIC WM] Created new workspace ${newWorkspace.index()} for ${mosaicWindows.length} mosaic windows`);
            
            // Move ALL mosaic windows to the same new workspace
            for (const mosaicWindow of mosaicWindows) {
                mosaicWindow.change_workspace(newWorkspace);
                console.log(`[MOSAIC WM] Moved window ${mosaicWindow.get_id()} to workspace ${newWorkspace.index()}`);
            }
            
            // Re-tile source workspace after moving windows
            // This ensures remaining windows (if any) adjust their layout
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                import('./tiling.js').then(tilingModule => {
                    tilingModule.tileWorkspaceWindows(workspace, null, monitor);
                    console.log(`[MOSAIC WM] Re-tiled source workspace ${workspace.index()} after overflow move`);
                });
                return GLib.SOURCE_REMOVE;
            });
            
            // Activate the new workspace to follow the windows
            newWorkspace.activate(global.get_current_time());
        });
    } else {
        console.log('[MOSAIC WM] Mosaic windows fit in remaining space - no overflow');
    }
}

/**
 * Check if a single quarter tile should expand to half tile
 * Called when a window is destroyed
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 */
export function checkQuarterExpansion(workspace, monitor) {
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    
    if (edgeTiledWindows.length === 0) {
        return;
    }
    
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Check left side for single quarter
    const leftQuarters = edgeTiledWindows.filter(w => 
        w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
    );
    
    if (leftQuarters.length === 1) {
        // Expand to LEFT_FULL
        const window = leftQuarters[0].window;
        console.log(`[MOSAIC WM] Single quarter on left - expanding to LEFT_FULL`);
        
        // Update state and apply tile
        const state = _windowStates.get(window.get_id());
        if (state) {
            state.zone = TileZone.LEFT_FULL;
        }
        
        const rect = getZoneRect(TileZone.LEFT_FULL, workArea, window);
        if (rect) {
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        }
    }
    
    // Check right side for single quarter
    const rightQuarters = edgeTiledWindows.filter(w => 
        w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
    );
    
    if (rightQuarters.length === 1) {
        // Expand to RIGHT_FULL
        const window = rightQuarters[0].window;
        console.log(`[MOSAIC WM] Single quarter on right - expanding to RIGHT_FULL`);
        
        // Update state and apply tile
        const state = _windowStates.get(window.get_id());
        if (state) {
            state.zone = TileZone.RIGHT_FULL;
        }
        
        const rect = getZoneRect(TileZone.RIGHT_FULL, workArea, window);
        if (rect) {
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        }
    }
}

/**
 * Clear all window states (cleanup)
 */
export function clearAllStates() {
    _windowStates.clear();
}

// ============================================================================
// INTERACTIVE RESIZE SYSTEM
// ============================================================================

/**
 * Setup resize listener for edge-tiled window
 * @param {Meta.Window} window
 */
export function setupResizeListener(window) {
    const winId = window.get_id();
    
    if (_resizeListeners.has(winId)) {
        return; // Already listening
    }
    
    const signalId = window.connect('size-changed', () => {
        handleWindowResize(window);
    });
    
    _resizeListeners.set(winId, signalId);
    console.log(`[MOSAIC WM] Setup resize listener for window ${winId}`);
}

/**
 * Remove resize listener from window
 * @param {Meta.Window} window
 */
function removeResizeListener(window) {
    const winId = window.get_id();
    const signalId = _resizeListeners.get(winId);
    
    if (signalId) {
        window.disconnect(signalId);
        _resizeListeners.delete(winId);
        console.log(`[MOSAIC WM] Removed resize listener from window ${winId}`);
    }
}

/**
 * Handle window resize event
 * @param {Meta.Window} window
 */
function handleWindowResize(window) {
    // Check if window is edge-tiled
    const state = getWindowState(window);
    if (!state || state.zone === TileZone.NONE) {
        return;
    }
    
    // Ignore programmatic resizes (from our own code)
    if (_isResizing) {
        return;
    }
    
    console.log(`[MOSAIC WM] Resize detected on edge-tiled window ${window.get_id()}, zone=${state.zone}`);
    
    // Handle resize based on zone
    if (state.zone === TileZone.LEFT_FULL || state.zone === TileZone.RIGHT_FULL) {
        handleHorizontalResize(window, state.zone);
    } else if (isQuarterZone(state.zone)) {
        handleVerticalResize(window, state.zone);
    }
}

/**
 * Handle horizontal resize between LEFT_FULL and RIGHT_FULL windows
 * @param {Meta.Window} window - Window being resized
 * @param {number} zone - TileZone of the window
 */
function handleHorizontalResize(window, zone) {
    const workspace = window.get_workspace();
    const monitor = window.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Find adjacent window
    const adjacentWindow = getAdjacentWindow(window, workspace, monitor, zone);
    
    if (!adjacentWindow) {
        // No adjacent window - resize affects mosaic
        // But only if we're not already in a resize operation
        if (!_isResizing) {
            console.log(`[MOSAIC WM] No adjacent window - resize affects mosaic`);
            handleResizeWithMosaic(window, workspace, monitor);
        }
        return;
    }
    
    // Resize both windows proportionally
    console.log(`[MOSAIC WM] Resizing tiled pair`);
    resizeTiledPair(window, adjacentWindow, workArea, zone);
}

/**
 * Handle vertical resize between quarter tiles (TOP ↔ BOTTOM)
 * @param {Meta.Window} window - Window being resized
 * @param {number} zone - TileZone of the window
 */
function handleVerticalResize(window, zone) {
    const workspace = window.get_workspace();
    const monitor = window.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Find adjacent quarter window (vertical pair)
    const adjacentZone = getAdjacentQuarterZone(zone);
    if (!adjacentZone) {
        return;
    }
    
    const adjacentWindow = findWindowInZone(adjacentZone, workspace);
    
    if (!adjacentWindow) {
        console.log(`[MOSAIC WM] No adjacent quarter - resize affects mosaic`);
        return;
    }
    
    const resizedId = window.get_id();
    const adjacentId = adjacentWindow.get_id();
    const resizedFrame = window.get_frame_rect();
    const adjacentFrame = adjacentWindow.get_frame_rect();
    
    // Get previous size
    const previousState = _previousSizes.get(resizedId);
    
    if (!previousState) {
        // First resize - just store current size and position
        _previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: resizedFrame.y });
        _previousSizes.set(adjacentId, { width: adjacentFrame.width, height: adjacentFrame.height, y: adjacentFrame.y });
        console.log(`[MOSAIC WM] Stored initial quarter states: resized=${resizedFrame.height}px@y${resizedFrame.y}, adjacent=${adjacentFrame.height}px@y${adjacentFrame.y}`);
        return;
    }
    
    // Calculate delta (how much the window changed)
    const deltaHeight = resizedFrame.height - previousState.height;
    
    console.log(`[MOSAIC WM] Vertical resize delta: ${deltaHeight}px (was ${previousState.height}px, now ${resizedFrame.height}px)`);
    
    // Calculate adjacent height based on TOTAL AVAILABLE SPACE to prevent gaps
    // Instead of (adjacent - delta), use (total - resized)
    const newAdjacentHeight = workArea.height - resizedFrame.height;
    
    // Check BOTH minimum constraints
    const minHeight = 100; // Minimum usable height for quarter tile
    const maxResizedHeight = workArea.height - minHeight;
    
    // Validate resized window doesn't exceed maximum
    if (resizedFrame.height > maxResizedHeight) {
        console.log(`[MOSAIC WM] Maximum height reached (${resizedFrame.height}px > ${maxResizedHeight}px) - stopping resize`);
        // Don't update _previousSizes so next event will still see the delta
        return;
    }
    
    // Validate adjacent window doesn't go below minimum
    if (newAdjacentHeight < minHeight) {
        console.log(`[MOSAIC WM] Adjacent minimum height reached (${newAdjacentHeight}px < ${minHeight}px) - stopping resize`);
        // Don't update _previousSizes so next event will still see the delta
        return;
    }
    
    // Determine positions based on which is TOP and which is BOTTOM
    const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
    
    // Apply delta resize
    _isResizing = true;
    
    try {
        if (isResizedTop) {
            // Resized is TOP, adjacent is BOTTOM
            // IMPORTANT: Call move_frame() before move_resize_frame() (gTile solution)
            window.move_frame(false, resizedFrame.x, workArea.y);
            window.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, resizedFrame.height);
            
            const adjacentY = workArea.y + resizedFrame.height;
            adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
            adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, newAdjacentHeight);
        } else {
            // Resized is BOTTOM, adjacent is TOP
            // IMPORTANT: Call move_frame() before move_resize_frame() (gTile solution)
            adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
            adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newAdjacentHeight);
            
            const resizedY = workArea.y + newAdjacentHeight;
            window.move_frame(false, resizedFrame.x, resizedY);
            window.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, resizedFrame.height);
        }
        
        console.log(`[MOSAIC WM] Applied vertical delta resize: resized=${resizedFrame.height}px, adjacent=${newAdjacentHeight}px, total=${resizedFrame.height + newAdjacentHeight}px`);
        
        // Update stored sizes
        if (isResizedTop) {
            _previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: workArea.y });
            _previousSizes.set(adjacentId, { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y + resizedFrame.height });
        } else {
            _previousSizes.set(adjacentId, { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y });
            _previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: workArea.y + newAdjacentHeight });
        }
    } finally {
        // Use timeout to reset flag after resize events have been processed
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2, () => {
            _isResizing = false;
            return GLib.SOURCE_REMOVE;
        });
    }
}

/**
 * Find adjacent edge-tiled window
 * @param {Meta.Window} window
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @param {number} zone
 * @returns {Meta.Window|null}
 */
function getAdjacentWindow(window, workspace, monitor, zone) {
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    const windowId = window.get_id();
    
    // Find opposite side window
    const targetZone = (zone === TileZone.LEFT_FULL) ? TileZone.RIGHT_FULL : TileZone.LEFT_FULL;
    
    const adjacent = edgeTiledWindows.find(w => 
        w.window.get_id() !== windowId && w.zone === targetZone
    );
    
    return adjacent ? adjacent.window : null;
}

/**
 * Resize a pair of tiled windows proportionally
 * @param {Meta.Window} resizedWindow - Window that was resized by user
 * @param {Meta.Window} adjacentWindow - Window on opposite side
 * @param {Object} workArea - Work area rectangle
 * @param {number} zone - Zone of resized window
 */
function resizeTiledPair(resizedWindow, adjacentWindow, workArea, zone) {
    const resizedId = resizedWindow.get_id();
    const adjacentId = adjacentWindow.get_id();
    const resizedFrame = resizedWindow.get_frame_rect();
    const adjacentFrame = adjacentWindow.get_frame_rect();
    
    // Get previous size
    const previousState = _previousSizes.get(resizedId);
    
    if (!previousState) {
        // First resize - just store current size and position
        _previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, x: resizedFrame.x });
        _previousSizes.set(adjacentId, { width: adjacentFrame.width, height: resizedFrame.height, x: adjacentFrame.x });
        console.log(`[MOSAIC WM] Stored initial states: resized=${resizedFrame.width}px@${resizedFrame.x}, adjacent=${adjacentFrame.width}px@${adjacentFrame.x}`);
        return;
    }
    
    // Check if resize is on the shared edge (inner edge) or outer edge
    // LEFT_FULL: Inner edge is Right. If X changed, it was Left edge (outer).
    // RIGHT_FULL: Inner edge is Left. If X stayed same, it was Right edge (outer).
    const isLeftWindow = (zone === TileZone.LEFT_FULL);
    const xChanged = (resizedFrame.x !== previousState.x);
    
    const isOuterEdgeResize = (isLeftWindow && xChanged) || (!isLeftWindow && !xChanged);
    
    if (isOuterEdgeResize) {
        console.log(`[MOSAIC WM] Outer edge resize detected - will adjust adjacent window to fill workspace`);
    }
    
    // Calculate delta (how much the window changed)
    const deltaWidth = resizedFrame.width - previousState.width;
    
    // NOTE: We don't return early on deltaWidth === 0 because we might need to fix gaps
    
    console.log(`[MOSAIC WM] Resize delta: ${deltaWidth}px (was ${previousState.width}px, now ${resizedFrame.width}px)`);
    
    // Check MAXIMUM width constraint to prevent adjacent window from becoming too small
    // Maximum width = total width - minimum width for adjacent window
    const minWidth = 400;
    const maxResizedWidth = workArea.width - minWidth;
    
    // If we've hit the maximum, STOP trying to resize (prevents jitter)
    // The final adjustment will happen when user releases the mouse
    if (resizedFrame.width > maxResizedWidth) {
        console.log(`[MOSAIC WM] Maximum width reached (${resizedFrame.width}px > ${maxResizedWidth}px) - stopping resize`);
        // Don't update _previousSizes so next event will still see the delta
        return;
    }
    
    // Calculate adjacent width based on TOTAL AVAILABLE SPACE to prevent gaps
    // Instead of (adjacent - delta), use (total - resized)
    const newAdjacentWidth = workArea.width - resizedFrame.width;
    
    // Apply delta resize
    _isResizing = true;
    
    try {
        // Determine which is left/right
        const isResizedLeft = (zone === TileZone.LEFT_FULL);
        
        if (isResizedLeft) {
            // Resized is left, adjacent is right
            // IMPORTANT: Call move_frame() before move_resize_frame() (gTile solution)
            resizedWindow.move_frame(false, workArea.x, workArea.y);
            resizedWindow.move_resize_frame(false, workArea.x, workArea.y, resizedFrame.width, workArea.height);
            
            adjacentWindow.move_frame(false, workArea.x + resizedFrame.width, workArea.y);
            adjacentWindow.move_resize_frame(false, workArea.x + resizedFrame.width, workArea.y, newAdjacentWidth, workArea.height);
        } else {
            // Resized is right, adjacent is left
            // IMPORTANT: Call move_frame() before move_resize_frame() (gTile solution)
            adjacentWindow.move_frame(false, workArea.x, workArea.y);
            adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, newAdjacentWidth, workArea.height);
            
            resizedWindow.move_frame(false, workArea.x + newAdjacentWidth, workArea.y);
            resizedWindow.move_resize_frame(false, workArea.x + newAdjacentWidth, workArea.y, resizedFrame.width, workArea.height);
        }
        
        console.log(`[MOSAIC WM] Applied delta resize: resized=${resizedFrame.width}px, adjacent=${newAdjacentWidth}px, total=${resizedFrame.width + newAdjacentWidth}px`);
        
        // Update stored sizes
        _previousSizes.set(resizedId, { width: resizedFrame.width, height: workArea.height, x: isResizedLeft ? workArea.x : workArea.x + newAdjacentWidth });
        _previousSizes.set(adjacentId, { width: newAdjacentWidth, height: workArea.height, x: isResizedLeft ? workArea.x + resizedFrame.width : workArea.x });
    } finally {
        // Use timeout to reset flag after resize events have been processed
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2, () => {
            _isResizing = false;
            return GLib.SOURCE_REMOVE;
        });
    }
}

/**
 * Handle resize when there's no adjacent tiled window (affects mosaic)
 * @param {Meta.Window} window
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 */
function handleResizeWithMosaic(window, workspace, monitor) {
    // Check if workspace is fully occupied by edge-tiled windows
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    
    // If both sides are tiled, no mosaic to adjust
    const hasLeft = edgeTiledWindows.some(w => 
        w.zone === TileZone.LEFT_FULL || w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
    );
    const hasRight = edgeTiledWindows.some(w => 
        w.zone === TileZone.RIGHT_FULL || w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
    );
    
    if (hasLeft && hasRight) {
        console.log(`[MOSAIC WM] Workspace fully occupied - no mosaic to re-tile`);
        return;
    }
    
    // Recalculate remaining space and re-tile mosaic
    console.log(`[MOSAIC WM] Edge-tiled window resized - re-tiling mosaic`);
    tiling.tileWorkspaceWindows(workspace, null, monitor, false);
}

/**
 * Fix tiled pair sizes after resize ends
 * Adjusts windows to fill workspace width, respecting actual minimum sizes
 * @param {Meta.Window} resizedWindow - Window that was resized
 * @param {number} zone - Zone of resized window
 */
export function fixTiledPairSizes(resizedWindow, zone) {
    const workspace = resizedWindow.get_workspace();
    const monitor = resizedWindow.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Find adjacent window
    const adjacentWindow = getAdjacentWindow(resizedWindow, workspace, monitor, zone);
    
    if (!adjacentWindow) {
        console.log(`[MOSAIC WM] No adjacent window found for size fix`);
        return;
    }
    
    
    const resizedFrame = resizedWindow.get_frame_rect();
    const adjacentFrame = adjacentWindow.get_frame_rect();
    
    // Use standard minimum width
    const minWidth = 400;
    
    // Calculate what the adjacent width SHOULD be based on the resized window
    const impliedAdjacentWidth = workArea.width - resizedFrame.width;
    
    console.log(`[MOSAIC WM] Post-resize check: resized=${resizedFrame.width}px, adjacent=${adjacentFrame.width}px, implied=${impliedAdjacentWidth}px, min=${minWidth}px`);
    
    // Check if the implied adjacent width is too small (meaning resized window is too big)
    // OR if there is a gap/overlap (implied != actual)
    if (impliedAdjacentWidth < minWidth) {
        console.log(`[MOSAIC WM] Implied adjacent width (${impliedAdjacentWidth}px) is smaller than minimum (${minWidth}px) - adjusting`);
        
        // Clamp adjacent to its minimum, give the rest to resized window
        const newAdjacentWidth = minWidth;
        const newResizedWidth = workArea.width - newAdjacentWidth;
        
        _isResizing = true;
        try {
            const isResizedLeft = (zone === TileZone.LEFT_FULL);
            
            if (isResizedLeft) {
                resizedWindow.move_frame(false, workArea.x, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x, workArea.y, newResizedWidth, workArea.height);
                
                adjacentWindow.move_frame(false, workArea.x + newResizedWidth, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x + newResizedWidth, workArea.y, newAdjacentWidth, workArea.height);
            } else {
                adjacentWindow.move_frame(false, workArea.x, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, newAdjacentWidth, workArea.height);
                
                resizedWindow.move_frame(false, workArea.x + newAdjacentWidth, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x + newAdjacentWidth, workArea.y, newResizedWidth, workArea.height);
            }
            
            console.log(`[MOSAIC WM] Adjusted sizes: resized=${newResizedWidth}px, adjacent=${newAdjacentWidth}px, total=${newResizedWidth + newAdjacentWidth}px`);
            
            // Update stored sizes
            _previousSizes.set(resizedWindow.get_id(), { width: newResizedWidth, height: workArea.height, x: isResizedLeft ? workArea.x : workArea.x + newAdjacentWidth });
            _previousSizes.set(adjacentWindow.get_id(), { width: newAdjacentWidth, height: workArea.height, x: isResizedLeft ? workArea.x + newResizedWidth : workArea.x });
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        return;
    }
    
    // Calculate actual total width
    const totalWidth = resizedFrame.width + adjacentFrame.width;
    
    // Check if there's a gap (total < workArea.width)
    if (totalWidth < workArea.width) {
        const gap = workArea.width - totalWidth;
        console.log(`[MOSAIC WM] Detected gap of ${gap}px - adjusting resized window`);
        
        // Give the gap to the resized window (the one that grew)
        const newResizedWidth = resizedFrame.width + gap;
        
        _isResizing = true;
        try {
            const isResizedLeft = (zone === TileZone.LEFT_FULL);
            
            if (isResizedLeft) {
                resizedWindow.move_frame(false, workArea.x, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x, workArea.y, newResizedWidth, workArea.height);
                
                adjacentWindow.move_frame(false, workArea.x + newResizedWidth, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x + newResizedWidth, workArea.y, adjacentFrame.width, workArea.height);
            } else {
                adjacentWindow.move_frame(false, workArea.x, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, adjacentFrame.width, workArea.height);
                
                resizedWindow.move_frame(false, workArea.x + adjacentFrame.width, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x + adjacentFrame.width, workArea.y, newResizedWidth, workArea.height);
            }
            
            console.log(`[MOSAIC WM] Fixed gap: resized=${newResizedWidth}px, adjacent=${adjacentFrame.width}px, total=${newResizedWidth + adjacentFrame.width}px`);
            
            // Update stored sizes
            _previousSizes.set(resizedWindow.get_id(), { width: newResizedWidth, height: workArea.height, x: isResizedLeft ? workArea.x : workArea.x + adjacentFrame.width });
            _previousSizes.set(adjacentWindow.get_id(), { width: adjacentFrame.width, height: workArea.height, x: isResizedLeft ? workArea.x + newResizedWidth : workArea.x });
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    } else {
        console.log(`[MOSAIC WM] No adjustment needed - sizes are correct`);
    }
}

/**
 * Fix quarter tile pair sizes after vertical resize ends
 * Adjusts windows to fill workspace height, respecting actual minimum sizes
 * @param {Meta.Window} resizedWindow - Window that was resized
 * @param {number} zone - Zone of resized window
 */
export function fixQuarterPairSizes(resizedWindow, zone) {
    const workspace = resizedWindow.get_workspace();
    const monitor = resizedWindow.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    // Find adjacent quarter window (vertical pair)
    const adjacentZone = getAdjacentQuarterZone(zone);
    if (!adjacentZone) {
        return;
    }
    
    const adjacentWindow = findWindowInZone(adjacentZone, workspace);
    
    if (!adjacentWindow) {
        console.log(`[MOSAIC WM] No adjacent quarter found for size fix`);
        return;
    }
    
    const resizedFrame = resizedWindow.get_frame_rect();
    const adjacentFrame = adjacentWindow.get_frame_rect();
    
    // The adjacent window's CURRENT height is the minimum it can be
    // because the compositor already enforced its minHeight during resize
    // Use 200px as absolute minimum protection
    const absoluteMinHeight = 200;
    const minHeight = Math.max(adjacentFrame.height, absoluteMinHeight);
    
    // Calculate what the adjacent height SHOULD be based on the resized window
    const impliedAdjacentHeight = workArea.height - resizedFrame.height;
    
    console.log(`[MOSAIC WM] Post-resize check (quarters): resized=${resizedFrame.height}px, adjacent=${adjacentFrame.height}px, implied=${impliedAdjacentHeight}px, min=${minHeight}px`);
    
    // IMPORTANT: Check the IMPLIED height (what it should be), not the current frame height
    // The current frame height might be stale from before the last resize event
    
    // Check if the implied adjacent height is too small (meaning resized window is too big)
    // OR if there is a gap/overlap (implied != actual)
    if (impliedAdjacentHeight < minHeight) {
        console.log(`[MOSAIC WM] Implied adjacent height (${impliedAdjacentHeight}px) is smaller than minimum (${minHeight}px) - adjusting`);
        
        // Clamp adjacent to its minimum, give the rest to resized window
        const newAdjacentHeight = minHeight;
        const newResizedHeight = workArea.height - newAdjacentHeight;
        
        _isResizing = true;
        try {
            const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
            
            if (isResizedTop) {
                // Resized is TOP, adjacent is BOTTOM
                resizedWindow.move_frame(false, resizedFrame.x, workArea.y);
                resizedWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newResizedHeight);
                
                const adjacentY = workArea.y + newResizedHeight;
                adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, newAdjacentHeight);
            } else {
                // Resized is BOTTOM, adjacent is TOP
                adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newAdjacentHeight);
                
                const resizedY = workArea.y + newAdjacentHeight;
                resizedWindow.move_frame(false, resizedFrame.x, resizedY);
                resizedWindow.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, newResizedHeight);
            }
            
            console.log(`[MOSAIC WM] Adjusted quarter sizes: resized=${newResizedHeight}px, adjacent=${newAdjacentHeight}px, total=${newResizedHeight + newAdjacentHeight}px`);
            
            // Update stored sizes
            if (isResizedTop) {
                _previousSizes.set(resizedWindow.get_id(), { width: resizedFrame.width, height: newResizedHeight, y: workArea.y });
                _previousSizes.set(adjacentWindow.get_id(), { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y + newResizedHeight });
            } else {
                _previousSizes.set(adjacentWindow.get_id(), { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y });
                _previousSizes.set(resizedWindow.get_id(), { width: resizedFrame.width, height: newResizedHeight, y: workArea.y + newAdjacentHeight });
            }
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        return;
    }
    
    // Calculate actual total height
    const totalHeight = resizedFrame.height + adjacentFrame.height;
    
    // Check if there's a gap (total < workArea.height)
    if (totalHeight < workArea.height) {
        const gap = workArea.height - totalHeight;
        console.log(`[MOSAIC WM] Detected vertical gap of ${gap}px - adjusting resized window`);
        
        // Give the gap to the resized window (the one that grew)
        const newResizedHeight = resizedFrame.height + gap;
        
        _isResizing = true;
        try {
            const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
            
            if (isResizedTop) {
                // Resized is TOP
                resizedWindow.move_frame(false, resizedFrame.x, workArea.y);
                resizedWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newResizedHeight);
                
                const adjacentY = workArea.y + newResizedHeight;
                adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, adjacentFrame.height);
            } else {
                // Resized is BOTTOM
                adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, adjacentFrame.height);
                
                const resizedY = workArea.y + adjacentFrame.height;
                resizedWindow.move_frame(false, resizedFrame.x, resizedY);
                resizedWindow.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, newResizedHeight);
            }
            
            console.log(`[MOSAIC WM] Closed vertical gap: resized=${newResizedHeight}px, adjacent=${adjacentFrame.height}px, total=${newResizedHeight + adjacentFrame.height}px`);
            
            // Update stored sizes
            if (isResizedTop) {
                _previousSizes.set(resizedWindow.get_id(), { width: resizedFrame.width, height: newResizedHeight, y: workArea.y });
                _previousSizes.set(adjacentWindow.get_id(), { width: resizedFrame.width, height: adjacentFrame.height, y: workArea.y + newResizedHeight });
            } else {
                _previousSizes.set(adjacentWindow.get_id(), { width: resizedFrame.width, height: adjacentFrame.height, y: workArea.y });
                _previousSizes.set(resizedWindow.get_id(), { width: resizedFrame.width, height: newResizedHeight, y: workArea.y + adjacentFrame.height });
            }
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        return;
    }
    
    console.log(`[MOSAIC WM] Quarter pair sizes OK - no adjustment needed`);
}
