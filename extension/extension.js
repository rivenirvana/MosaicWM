/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Meta from 'gi://Meta';
import * as windowing from './windowing.js';
import * as tiling from './tiling.js';
import * as drawing from './drawing.js';
import * as reordering from './reordering.js';
import * as constants from './constants.js';

function tileWindowWorkspace(meta_window) {
    if(!meta_window) return;
    let workspace = meta_window.get_workspace();
    if(!workspace) return;
    tiling.tileWorkspaceWindows(workspace, 
                                  meta_window, 
                                  null, 
                                  false);
}

export default class WindowMosaicExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = []; // Tracks workspace-level event connections
        this._maximizedWindows = [];
        this._workspaceManager = global.workspace_manager;
        this._sizeChanged = false;
        this._tileTimeout = null;
        this._windowWorkspaceSignals = new Map(); // window_id -> signal_id for workspace-changed
        this._workspaceChangeTimeout = null; // Debounce timeout for manual workspace changes
        this._windowPreviousWorkspace = new Map(); // window_id -> previous_workspace_index for overview drag-drop
        this._windowRemovedTimestamp = new Map(); // window_id -> timestamp when removed
        this._manualWorkspaceMove = new Map(); // window_id -> true if manual move (workspace-changed fired)
    }

    _tileAllWorkspaces = () => {
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            // Recurse all monitors
            let nMonitors = global.display.get_n_monitors();
            for(let j = 0; j < nMonitors; j++)
                tiling.tileWorkspaceWindows(workspace, false, j, true);
        }
    }

    /**
     * Handler called when a new window is created in the display.
     * 
     * OVERFLOW FLOW (Main requirement):
     * 1. Every new window goes through space optimization calculation
     * 2. If it fits in current workspace → add to tiling
     * 3. If it DOESN'T fit → move to new workspace
     * 
     * SPECIAL RULES:
     * - Workspace with maximized window = completely occupied
     * - Maximized window with other apps → move maximized to new workspace
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The newly created window
     */
    _windowCreatedHandler = (_, window) => {
        let timeout = setInterval(() => {
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();
            
            // Ensure window is valid before any action
            if( monitor !== null &&
                window.wm_class !== null &&
                window.get_compositor_private() &&
                workspace.list_windows().length !== 0 &&
                !window.is_hidden())
            {
                clearTimeout(timeout);
                
                // Check if window should be managed (includes blacklist check)
                if(windowing.isExcluded(window)) {
                    console.log('[MOSAIC WM] Window excluded from tiling');
                    return; // Window should not be managed (dialog, blacklisted, etc.)
                }
                
                // CASE 1: Window is maximized/fullscreen AND there are other apps in workspace
                // → Move maximized window to new workspace
                // IMPORTANT: Only move if workspace is NOT empty (has other windows)
                if(windowing.isMaximizedOrFullscreen(window)) {
                    const workspaceWindows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
                    
                    // Only move to new workspace if there are OTHER windows (length > 1)
                    // If workspace is empty or only has this window, keep it here
                    if(workspaceWindows.length > 1) {
                        console.log('[MOSAIC WM] Maximized window with other apps - moving to new workspace');
                        windowing.moveOversizedWindow(window);
                        return;
                    } else {
                        console.log('[MOSAIC WM] Maximized window in empty workspace - keeping here');
                        // Don't move, just tile normally (will be alone in workspace)
                        tiling.tileWorkspaceWindows(workspace, window, monitor, false);
                        return;
                    }
                }
                
                // CASE 2: Check if window FITS in current workspace
                // Uses canFitWindow() which checks:
                // - If workspace has maximized window (= occupied)
                // - If adding would cause overflow
                const canFit = tiling.canFitWindow(window, workspace, monitor);
                
                if(!canFit) {
                    // DOESN'T FIT → Create new workspace and move window
                    console.log('[MOSAIC WM] Window doesn\'t fit - moving to new workspace');
                    windowing.moveOversizedWindow(window);
                } else {
                    // FITS → Add to tiling in current workspace
                    console.log('[MOSAIC WM] Window fits - adding to tiling');
                    tiling.tileWorkspaceWindows(workspace, window, monitor, false);
                }
                
                // Connect workspace-changed signal to detect manual window movement
                this._connectWindowWorkspaceSignal(window);
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    _destroyedHandler = (_, win) => {
        let window = win.meta_window;
        let monitor = window.get_monitor();
        const windowId = window.get_id();
        
        // Disconnect workspace-changed signal
        this._disconnectWindowWorkspaceSignal(window);
        
        // Clean up tracking Maps to prevent memory leaks
        this._windowPreviousWorkspace.delete(windowId);
        this._windowRemovedTimestamp.delete(windowId);
        this._manualWorkspaceMove.delete(windowId);
        
        // Only process if window was managed (not excluded/blacklisted)
        if(windowing.isExcluded(window)) {
            console.log('[MOSAIC WM] Excluded window closed - no workspace navigation');
            return;
        }
        
        if(monitor === global.display.get_primary_monitor()) {
            const workspace = windowing.getWorkspace();
            
            // Re-tile workspace after window is closed
            // Use null as reference to tile all remaining windows
            tiling.tileWorkspaceWindows(workspace, 
                null,  // No reference window - tile all windows
                monitor,
                true);
            
            // Check if workspace is now empty and navigate to previous if so
            const windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
            const managedWindows = windows.filter(w => !windowing.isExcluded(w));
            
            if (managedWindows.length === 0) {
                console.log('[MOSAIC WM] Workspace is empty - checking if should navigate');
                
                const workspaceManager = global.workspace_manager;
                const currentIndex = workspace.index();
                
                // Only navigate away if:
                // 1. We're not in workspace 0 (first workspace), OR
                // 2. There's a non-empty workspace to navigate to
                
                // Check if there's a previous non-empty workspace
                let shouldNavigate = false;
                let targetWorkspace = null;
                
                if (currentIndex > 0) {
                    // Try to navigate to previous workspace
                    const previousWorkspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                    if (previousWorkspace && previousWorkspace.index() !== currentIndex) {
                        const prevWindows = windowing.getMonitorWorkspaceWindows(previousWorkspace, monitor);
                        const prevManagedWindows = prevWindows.filter(w => !windowing.isExcluded(w));
                        
                        if (prevManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = previousWorkspace;
                            console.log(`[MOSAIC WM] Found non-empty previous workspace ${previousWorkspace.index()}`);
                        }
                    }
                }
                
                // If no previous non-empty workspace, check next (but only if we're not in workspace 0)
                if (!shouldNavigate && currentIndex > 0) {
                    const nextWorkspace = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
                    if (nextWorkspace && nextWorkspace.index() !== currentIndex) {
                        const nextWindows = windowing.getMonitorWorkspaceWindows(nextWorkspace, monitor);
                        const nextManagedWindows = nextWindows.filter(w => !windowing.isExcluded(w));
                        
                        if (nextManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = nextWorkspace;
                            console.log(`[MOSAIC WM] Found non-empty next workspace ${nextWorkspace.index()}`);
                        }
                    }
                }
                
                if (shouldNavigate && targetWorkspace) {
                    targetWorkspace.activate(global.get_current_time());
                    console.log(`[MOSAIC WM] Navigated to workspace ${targetWorkspace.index()}`);
                } else {
                    console.log('[MOSAIC WM] Staying in current workspace (workspace 0 or no non-empty workspaces available)');
                }
            }
        }
    }
    
    _switchWorkspaceHandler = (_, win) => {
        tileWindowWorkspace(win.meta_window); // Tile when switching to a workspace. Helps to create a more cohesive experience.
    }

    /**
     * Handler for manual window movement between workspaces.
     * Uses debounce to avoid interrupting rapid navigation.
     * 
     * @param {Meta.Window} window - The window that changed workspace
     */
    _windowWorkspaceChangedHandler = (window) => {
        console.log(`[MOSAIC WM] workspace-changed fired for window ${window.get_id()}`);
        
        // Mark this as a manual workspace move (not overview drag-drop)
        this._manualWorkspaceMove.set(window.get_id(), true);
        
        // Store the previous workspace index so we can re-tile it after the move
        const previousWorkspaceIndex = this._windowPreviousWorkspace.get(window.get_id());
        
        // Clear any existing debounce timeout
        if (this._workspaceChangeTimeout) {
            console.log('[MOSAIC WM] Clearing previous debounce timeout');
            clearTimeout(this._workspaceChangeTimeout);
        }
        
        // Debounce: wait 500ms before checking overflow
        // This allows user to navigate through multiple workspaces without interruption
        this._workspaceChangeTimeout = setTimeout(() => {
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            
            console.log(`[MOSAIC WM] Debounce complete - checking overflow for window ${window.get_id()} in workspace ${workspace.index()}`);
            
            // Skip if window is excluded
            if (windowing.isExcluded(window)) {
                console.log('[MOSAIC WM] Window is excluded - skipping overflow check');
                return;
            }
            
            // Re-tile the source workspace to fill the gap left by the moved window
            if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== workspace.index()) {
                const workspaceManager = global.workspace_manager;
                const previousWorkspace = workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                if (previousWorkspace) {
                    console.log(`[MOSAIC WM] Re-tiling source workspace ${previousWorkspaceIndex} after window move`);
                    tiling.tileWorkspaceWindows(previousWorkspace, null, monitor, false);
                }
            }
            
            // Check if window fits in new workspace
            const canFit = tiling.canFitWindow(window, workspace, monitor);
            
            if (!canFit) {
                console.log('[MOSAIC WM] Manual move: window doesn\'t fit - moving to new workspace');
                windowing.moveOversizedWindow(window);
            } else {
                console.log('[MOSAIC WM] Manual move: window fits - tiling');
                tiling.tileWorkspaceWindows(workspace, window, monitor, false);
            }
        }, 500); // 500ms debounce
    }

    /**
     * Connect workspace-changed signal for a window.
     * 
     * @param {Meta.Window} window - The window to track
     */
    _connectWindowWorkspaceSignal(window) {
        const signalId = window.connect('workspace-changed', () => {
            this._windowWorkspaceChangedHandler(window);
        });
        this._windowWorkspaceSignals.set(window.get_id(), signalId);
    }

    /**
     * Disconnect workspace-changed signal for a window.
     * 
     * @param {Meta.Window} window - The window to stop tracking
     */
    _disconnectWindowWorkspaceSignal(window) {
        const windowId = window.get_id();
        const signalId = this._windowWorkspaceSignals.get(windowId);
        if (signalId) {
            window.disconnect(signalId);
            this._windowWorkspaceSignals.delete(windowId);
        }
    }

    /**
     * Handler called when a window's size changes (maximize/unmaximize/fullscreen).
     * Moves maximized/fullscreen windows to a new workspace if they're not alone.
     * 
     * @param {Meta.WindowManager} _ - The window manager (unused)
     * @param {Meta.WindowActor} win - The window actor
     * @param {number} mode - The size change mode (0=maximize, 1=unmaximize, 2=maximize, 3=unmaximize)
     */
    _sizeChangeHandler = (_, win, mode) => {
        let window = win.meta_window;
        if(!windowing.isExcluded(window)) {
            let id = window.get_id();
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();

            if(mode === 2 || mode === 0) { // If the window was maximized
                if(windowing.isMaximizedOrFullscreen(window) && windowing.getMonitorWorkspaceWindows(workspace, monitor).length > 1) {
                    // If maximized/fullscreen (and not alone), move to new workspace and activate it if it is on the active workspace
                    let newWorkspace = windowing.moveOversizedWindow(window);
                    /* We mark the window as activated by using its id to index an array
                        We put the value as the active workspace index so that if the workspace anatomy
                        of the current workspace changes, it does not move the maximized window to an unrelated
                        window.
                    */
                    if(newWorkspace) {
                        this._maximizedWindows[id] = {
                            workspace: newWorkspace.index(),
                            monitor: monitor
                        }; // Mark window as maximized
                        tiling.tileWorkspaceWindows(workspace, false, monitor, false); // Sort the workspace where the window came from
                    }
                }
            } else if(false && (mode === 3 || mode === 1)) { // If the window was unmaximized
                if( !windowing.isMaximizedOrFullscreen(window) && // If window is not maximized
                    this._maximizedWindows[id] &&
                    windowing.getMonitorWorkspaceWindows(workspace, monitor).length === 1// If the workspace anatomy has not changed
                ) {
                    if( this._maximizedWindows[id].workspace === workspace.index() &&
                        this._maximizedWindows[id].monitor === monitor
                    ) {
                        this._maximizedWindows[id] = false;
                        windowing.moveBackWindow(window); // Move the window back to its workspace
                        tileWindowWorkspace(window);
                    }
                }
            }
        }
    }

    _sizeChangedHandler = (_, win) => {
        let window = win.meta_window;
        if(!this._sizeChanged && !windowing.isExcluded(window)) {
            // Live resizing
            this._sizeChanged = true;
            tiling.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), true);
            this._sizeChanged = false;
        }
    }

    /**
     * Handler called when a grab operation begins (window is being moved or resized).
     * Starts the drag-and-drop reordering process if the window is being moved.
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The window being grabbed
     * @param {number} grabpo - The grab operation type
     */
    _grabOpBeginHandler = (_, window, grabpo) => {
        if( !windowing.isExcluded(window) &&
            (grabpo === 1 || grabpo === 1025) && // When a window has moved
            !(windowing.isMaximizedOrFullscreen(window)))
            reordering.startDrag(window);
        // tileWindowWorkspace(window);
    }
    
    /**
     * Handler called when a grab operation ends (window released after move/resize).
     * Stops the drag operation and re-tiles the workspace if needed.
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The window that was grabbed
     * @param {number} grabpo - The grab operation type
     */
    _grabOpEndHandler = (_, window, grabpo) => {
        if(!windowing.isExcluded(window)) {
            reordering.stopDrag(window);
            if( (grabpo === 1 || grabpo === 1025) && // When a window has moved
                !(windowing.isMaximizedOrFullscreen(window)))
            {
                tiling.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
            }
            if(grabpo === 25601) // When released from resizing
                tileWindowWorkspace(window);
        } else
            reordering.stopDrag(window, true);
    }

    /**
     * Handler called when a window is added to a workspace.
     * This is triggered by workspace.connect('window-added').
     * Handles both new window creation and overview drag-drop.
     * 
     * For overview drag-drop: checks overflow and returns window to previous workspace if needed.
     * For new windows: just tiles normally (no overflow check to avoid infinite loops).
     * 
     * @param {Meta.Workspace} workspace - The workspace that received the window
     * @param {Meta.Window} window - The window that was added
     */
    _windowAdded = (workspace, window) => {
        let timeout = setInterval(() => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (tiling.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                clearTimeout(timeout);
                
                // Get window frame to check if it's a new window or existing one
                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;
                
                // Check if this is an overview drag-drop (has different previous workspace AND happened recently)
                const previousWorkspaceIndex = this._windowPreviousWorkspace.get(WINDOW.get_id());
                const removedTimestamp = this._windowRemovedTimestamp.get(WINDOW.get_id());
                const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;
                const isManualMove = this._manualWorkspaceMove.get(WINDOW.get_id());
                
                console.log(`[MOSAIC WM] window-added debug: window=${WINDOW.get_id()}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}, isManual=${isManualMove}`);
                
                // Overview drag-drop: fast (<3s), different workspace, NOT a manual move
                // Manual moves are handled by workspace-changed signal (500ms debounce)
                const isOverviewDragDrop = previousWorkspaceIndex !== undefined && 
                                          previousWorkspaceIndex !== WORKSPACE.index() &&
                                          timeSinceRemoved < 3000 &&
                                          !isManualMove;
                
                // Only check overflow for overview drag-drop operations
                // Skip new windows (no previous workspace) to avoid infinite loops
                if (hasValidDimensions && !windowing.isExcluded(WINDOW) && isOverviewDragDrop) {
                    console.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                    
                    const canFit = tiling.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                    
                    if (!canFit) {
                        // Return to previous workspace
                        console.log(`[MOSAIC WM] window-added: Doesn't fit - returning to workspace ${previousWorkspaceIndex}`);
                        const previousWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                        if (previousWorkspace) {
                            WINDOW.change_workspace(previousWorkspace);
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            return; // Don't tile, window is being moved back
                        }
                    } else {
                        // Clean up tracking if window fits
                        this._windowPreviousWorkspace.delete(WINDOW.get_id());
                        this._windowRemovedTimestamp.delete(WINDOW.get_id());
                        this._manualWorkspaceMove.delete(WINDOW.get_id());
                    }
                }
                
                // Tile the workspace
                tiling.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    /**
     * Handler called when a window is removed from a workspace.
     * This is triggered by workspace.connect('window-removed').
     * Re-tiles the workspace and handles workspace navigation if empty.
     * Also tracks the previous workspace for overview drag-drop.
     * 
     * @param {Meta.Workspace} workspace - The workspace that lost the window
     * @param {Meta.Window} window - The window that was removed
     */
    _windowRemoved = (workspace, window) => {
        // Track previous workspace and timestamp for overview drag-drop detection
        this._windowPreviousWorkspace.set(window.get_id(), workspace.index());
        this._windowRemovedTimestamp.set(window.get_id(), Date.now());
        
        let timeout = setInterval(() => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (tiling.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                clearTimeout(timeout);
                tiling.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            } else {
                clearTimeout(timeout);
                return;
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    /**
     * Handler called when a new workspace is added to the workspace manager.
     * Connects window-added and window-removed listeners to the new workspace.
     * 
     * @param {Meta.WorkspaceManager} _ - The workspace manager (unused)
     * @param {number} workspaceIdx - The index of the newly added workspace
     */
    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        let eventIds = [];
        eventIds.push(workspace.connect("window-added", this._windowAdded));
        eventIds.push(workspace.connect("window-removed", this._windowRemoved));
        this._workspaceEventIds.push([workspace, eventIds]);
    }

    enable() {
        console.log("[MOSAIC WM]: Starting Mosaic layout manager.");
        
        this._wmEventIds.push(global.window_manager.connect('size-change', this._sizeChangeHandler));
        this._wmEventIds.push(global.window_manager.connect('size-changed', this._sizeChangedHandler));
        this._displayEventIds.push(global.display.connect('window-created', this._windowCreatedHandler));
        this._wmEventIds.push(global.window_manager.connect('destroy', this._destroyedHandler));
        this._displayEventIds.push(global.display.connect("grab-op-begin", this._grabOpBeginHandler));
        this._displayEventIds.push(global.display.connect("grab-op-end", this._grabOpEndHandler));
        
        // Connect workspace-added listener to attach listeners to new workspaces
        this._workspaceManEventIds.push(global.workspace_manager.connect("workspace-added", this._workspaceAddSignal));

        // Connect window-added and window-removed listeners to all existing workspaces
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let eventIds = [];
            eventIds.push(workspace.connect("window-added", this._windowAdded));
            eventIds.push(workspace.connect("window-removed", this._windowRemoved));
            this._workspaceEventIds.push([workspace, eventIds]);
        }

        // Sort all workspaces at startup
        setTimeout(this._tileAllWorkspaces, constants.STARTUP_TILE_DELAY_MS);
        this._tileTimeout = setInterval(this._tileAllWorkspaces, constants.TILE_INTERVAL_MS); // Tile all windows periodically
    }

    disable() {
        console.log("[MOSAIC WM]: Disabling Mosaic layout manager.");
        // Disconnect all events
        clearTimeout(this._tileTimeout);
        for(let eventId of this._wmEventIds)
            global.window_manager.disconnect(eventId);
        for(let eventId of this._displayEventIds)
            global.display.disconnect(eventId);
        for(let eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        // Disconnect workspace-level event listeners
        for(let container of this._workspaceEventIds) {
            const workspace = container[0];
            const eventIds = container[1];
            eventIds.forEach((eventId) => workspace.disconnect(eventId));
        }

        drawing.clearActors();

        // Cleanup workspace-changed signals
        this._windowWorkspaceSignals.forEach((signalId, windowId) => {
            const window = global.display.get_window_by_id(windowId);
            if (window) {
                window.disconnect(signalId);
            }
        });
        this._windowWorkspaceSignals.clear();
        
        // Clear debounce timeout
        if (this._workspaceChangeTimeout) {
            clearTimeout(this._workspaceChangeTimeout);
            this._workspaceChangeTimeout = null;
        }

        // Reset all event ID arrays to prevent memory leaks
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
    }
}