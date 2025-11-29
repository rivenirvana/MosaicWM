import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * SettingsOverrider - Safely override GNOME settings and restore on disable
 * 
 * Pattern from Tiling Assistant extension - saves original values and
 * restores them when the extension is disabled.
 */
export class SettingsOverrider {
    constructor() {
        this._overrides = new Map();
    }
    
    /**
     * Override a setting value
     * @param {Gio.Settings} settings - Settings object
     * @param {string} key - Setting key to override
     * @param {GLib.Variant} value - New value
     */
    add(settings, key, value) {
        const schemaId = settings.schema_id;
        
        if (!this._overrides.has(schemaId)) {
            this._overrides.set(schemaId, new Map());
        }
        
        const schemaOverrides = this._overrides.get(schemaId);
        
        // Save original value if not already saved
        if (!schemaOverrides.has(key)) {
            const originalValue = settings.get_value(key);
            schemaOverrides.set(key, originalValue);
        }
        
        // Apply override
        settings.set_value(key, value);
        console.log(`[MOSAIC WM] Overriding ${schemaId}.${key}`);
    }
    
    /**
     * Restore all overridden settings to their original values
     */
    clear() {
        // Restore all original values
        for (const [schemaId, overrides] of this._overrides) {
            const settings = new Gio.Settings({ schema_id: schemaId });
            
            for (const [key, originalValue] of overrides) {
                settings.set_value(key, originalValue);
                console.log(`[MOSAIC WM] Restored ${schemaId}.${key}`);
            }
        }
        
        this._overrides.clear();
    }
    
    /**
     * Cleanup and restore all settings
     */
    destroy() {
        this.clear();
        this._overrides = null;
    }
}
