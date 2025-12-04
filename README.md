# Mosaic WM

**Rethinking window management for GNOME Shell**

A GNOME Shell extension that provides automatic window tiling in a mosaic layout. Inspired by [GNOME's vision for rethinking window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/), Mosaic WM intelligently arranges windows to maximize screen space while maintaining visual harmony.

> [!WARNING]
> **Experimental Extension**: This extension is under active development and may contain bugs or unexpected behavior. Use at your own risk. Please report any issues.

## 💡 Philosophy

Traditional window management forces users to manually position and resize windows. Mosaic WM takes a different approach:

- **Automatic**: Windows organize themselves intelligently
- **Adaptive**: Layout responds to your workflow
- **Minimal**: No manual tiling or complex keyboard shortcuts needed
- **Visual**: See your workspace at a glance

This aligns with GNOME's philosophy of reducing cognitive load and letting users focus on their work, not window management.

## ✨ Features

- 🎯 **Automatic Tiling**: Windows are automatically arranged in an optimal mosaic layout
- 🔄 **Smart Overflow**: Oversized windows automatically move to new workspaces
- 🎨 **Drag & Drop**: Reorder windows by dragging them
- 🖥️ **Fullscreen Support**: Fullscreen and maximized windows get dedicated workspaces
- 👁️ **Visual Feedback**: See window positions during drag operations
- 🚀 **Performance**: Lightweight and efficient
- 🎛️ **Multi-Monitor**: Works seamlessly with multiple displays

## 📦 Installation

### From Source

```bash
# Clone the repository
git clone git@github.com:CleoMenezesJr/MosaicWM.git
cd MosaicWM

# Install the extension
./install.sh

# Enable the extension
gnome-extensions enable mosaicwm@cleomenezesjr.github.io

# Log out and log back in
```

### Manual Installation

1. Download the latest release
2. Extract to `~/.local/share/gnome-shell/extensions/mosaicwm@cleomenezesjr.github.io/`
3. Restart GNOME Shell (log out and log back in)
4. Enable via Extensions app or: `gnome-extensions enable mosaicwm@cleomenezesjr.github.io`

## 🎮 Usage

Once enabled, the extension works automatically:

- **Open windows**: They'll be automatically tiled
- **Drag windows**: Click and drag to reorder
- **Maximize/Fullscreen**: Window moves to its own workspace
- **Minimize**: Window is excluded from tiling
- **Too many windows**: Overflow windows move to new workspace

## 🛠️ Configuration

The extension uses sensible defaults, but you can customize constants in `extension/constants.js`:

```javascript
export const WINDOW_SPACING = 8;           // Space between windows (px)
export const TILE_INTERVAL_MS = 300000;    // Re-tile interval (5 min)
export const DRAG_UPDATE_INTERVAL_MS = 50; // Drag smoothness (ms)
```

## 🏗️ Architecture

```
extension/
├── extension.js    # Main extension class, event handlers
├── tiling.js       # Core tiling algorithm
├── windowing.js    # Window management utilities
├── reordering.js   # Drag-and-drop functionality
├── drawing.js      # Visual feedback rendering
├── constants.js    # Configuration constants
└── stylesheet.css  # Visual styles
```

### Key Components

- **WindowDescriptor**: Lightweight window representation for layout calculations
- **Level**: Horizontal row of windows in the tiling layout
- **Tiling Algorithm**: Distributes windows across levels to fit workspace

## 🧪 Development

### Prerequisites

- GNOME Shell 49+
- Git
- Basic JavaScript/GJS knowledge

### Building & Testing

```bash
# Test syntax
find extension -name "*.js" -exec gjs -c {} \;

# Install for testing
./install.sh

# Restart GNOME Shell
# Log out and log back in
```

### Debugging

For debugging and development tips, see the [GJS Extension Development Guide](https://gjs.guide/extensions/development/debugging.html).

View logs in real-time:

```bash
# Monitor extension logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i mosaic

# Or use GNOME's Looking Glass (Alt+F2 → 'lg')
# Navigate to Extensions tab to see errors
```

### Code Style

- **Functions**: camelCase (`tileWorkspaceWindows`)
- **Classes**: PascalCase (`WindowDescriptor`)
- **Constants**: UPPER_CASE (`WINDOW_SPACING`)
- **Private properties**: Prefix with `_` (`this._wmEventIds`)
- **Documentation**: JSDoc for all exported functions

### Technical Notes

This extension is designed for Wayland sessions and leverages modern compositor integration for proper window positioning and multi-monitor support.

For more information on GNOME Shell extension development:
- [GJS Extension Development Guide](https://gjs.guide/extensions/development/debugging.html)
- [GNOME Shell Extensions Documentation](https://gjs.guide/extensions/)

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test additions
- `chore:` Maintenance tasks

## 📝 License

This project is licensed under the GNU General Public License v2.0 or later - see the LICENSE file for details.

## 🙏 Acknowledgments

- Kudos to [heikkiket/window-mosaic-mode](https://gitlab.gnome.org/heikkiket/window-mosaic-mode) for the original concept and implementation
- Inspired by [Tobias Bernard's vision for GNOME window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/)
- GNOME Shell team for the excellent extension API
- Contributors and testers

## 📧 Contact

- **Author**: Cleo Menezes Jr
- **GitHub**: [@CleoMenezesJr](https://github.com/CleoMenezesJr)
- **Repository**: [MosaicWM](https://github.com/CleoMenezesJr/MosaicWM)

## 🐛 Known Issues

- None currently! Report issues on GitHub.

## 🗺️ Roadmap

- [ ] Settings panel for configuration
- [ ] Custom keyboard shortcuts
- [ ] Window gaps customization
- [ ] Animation improvements
- [ ] Per-workspace tiling rules
- [ ] Integration with GNOME's future window management improvements

---

**Made with ❤️ for the GNOME community**
