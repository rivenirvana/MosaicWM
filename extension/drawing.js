import st from 'gi://St';
import * as main from 'resource:///org/gnome/shell/ui/main.js';
import * as edgeTiling from './edgeTiling.js';

// Array of currently displayed feedback boxes
var boxes = [];

// Tile preview overlay for edge tiling
var _tilePreview = null;

/**
 * Creates a visual feedback rectangle at the specified position.
 * Used to show where a window will be positioned during drag operations.
 * The box uses the 'tile-preview' CSS class from stylesheet.css.
 * 
 * @param {number} x - X position of the box
 * @param {number} y - Y position of the box
 * @param {number} w - Width of the box
 * @param {number} h - Height of the box
 */
export function rect(x, y, w, h) {
    console.log(`[MOSAIC WM] rect() called: edgeTilingActive=${edgeTiling.isEdgeTilingActive()}, boxes=${boxes.length}`);
    
    // Don't show mosaic preview if edge tiling is active
    if (edgeTiling.isEdgeTilingActive()) {
        console.log(`[MOSAIC WM] Skipping mosaic preview - edge tiling is active`);
        return; // Skip mosaic preview entirely when edge tiling is active
    }
    
    // Hide edge tiling preview when showing mosaic preview
    hideTilePreview();
    
    const box = new st.Widget({ 
        style_class: "mosaic-preview",
        opacity: 200 // Ensure it's visible
    });
    box.set_position(x, y);
    box.set_size(w, h);
    
    boxes.push(box);
    main.uiGroup.add_child(box);
    console.log(`[MOSAIC WM] Mosaic preview created: ${boxes.length} boxes at (${x}, ${y}) ${w}x${h}`);
}

/**
 * Removes all visual feedback boxes from the screen.
 * Called when a drag operation ends or is cancelled.
 */
export function removeBoxes() {
    console.log(`[MOSAIC WM] removeBoxes() called: removing ${boxes.length} boxes`);
    for(let box of boxes) {
        main.uiGroup.remove_child(box);
    }
    boxes = [];
}

/**
 * Show edge tiling preview overlay
 * @param {number} zone - TileZone enum value
 * @param {Object} workArea - Work area rectangle
 */
export function showTilePreview(zone, workArea) {
    // Hide mosaic preview when showing edge tiling preview
    removeBoxes();
    
    const rect = edgeTiling.getZoneRect(zone, workArea);
    if (!rect) return;
    
    if (!_tilePreview) {
        _tilePreview = new st.Widget({
            style_class: 'tile-preview',
            opacity: 128
        });
        main.uiGroup.add_child(_tilePreview);
    }
    
    _tilePreview.set_position(rect.x, rect.y);
    _tilePreview.set_size(rect.width, rect.height);
    _tilePreview.show();
}

/**
 * Hide edge tiling preview overlay
 */
export function hideTilePreview() {
    if (_tilePreview) {
        _tilePreview.hide();
    }
}

/**
 * Clears all visual actors created by this module.
 * Called during extension disable to clean up.
 */
export function clearActors() {
    removeBoxes();
    if (_tilePreview) {
        main.uiGroup.remove_child(_tilePreview);
        _tilePreview = null;
    }
}