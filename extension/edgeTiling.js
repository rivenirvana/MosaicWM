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
        case TileZone.TOP_LEFT:
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: halfW, 
                height: halfH 
            };
        case TileZone.TOP_RIGHT:
            return { 
                x: workArea.x + halfW, 
                y: workArea.y, 
                width: workArea.width - halfW, 
                height: halfH 
            };
        case TileZone.BOTTOM_LEFT:
            return { 
                x: workArea.x, 
                y: workArea.y + halfH, 
                width: halfW, 
                height: workArea.height - halfH 
            };
        case TileZone.BOTTOM_RIGHT:
            return { 
                x: workArea.x + halfW, 
                y: workArea.y + halfH, 
                width: workArea.width - halfW, 
                height: workArea.height - halfH 
            };
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
    _windowStates.delete(window.get_id());
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
 * @returns {boolean} Success
 */
export function applyTile(window, zone, workArea) {
    // Save current window state before tiling
    saveWindowState(window);
    
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
    
    // Capture winId before callback
    const winId = window.get_id();
    
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
        
        // Check for mosaic overflow after tiling
        handleMosaicOverflow(window, zone);
        
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
            
            // Activate the new workspace to follow the windows
            newWorkspace.activate(global.get_current_time());
        });
    } else {
        console.log('[MOSAIC WM] Mosaic windows fit in remaining space - no overflow');
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
    }
    // TODO: Handle quarter tiles in Phase 2
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
