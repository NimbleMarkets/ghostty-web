#!/bin/bash
set -euo pipefail

echo "🔨 Building ghostty-vt.wasm..."

# Check for Zig (ghostty's build.zig pins a specific version)
if ! command -v zig &> /dev/null; then
    echo "❌ Error: Zig not found"
    echo ""
    echo "Use the version pinned by ghostty/build.zig (currently 0.15.2)."
    echo "  macOS:   brew install zig (may not match)"
    echo "  Nix:     nix develop"
    echo "  Manual:  https://ziglang.org/download/"
    echo ""
    exit 1
fi

ZIG_VERSION=$(zig version)
echo "✓ Found Zig $ZIG_VERSION"

# Initialize submodule on first checkout (gitlink is a file, not a directory)
if [ ! -e "ghostty/.git" ]; then
    echo "📦 Initializing Ghostty submodule..."
    git submodule update --init --recursive
else
    echo "📦 Ghostty submodule already initialized"
fi

# Ensure submodule worktree is clean before patching. If it's dirty, we
# refuse to proceed — applying the WASM API patch on top of unknown
# changes (or wiping them automatically) would silently destroy
# contributor work.
cd ghostty
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Error: Ghostty submodule has uncommitted changes."
    echo ""
    git status --short | sed 's/^/    /'
    echo ""
    echo "The build needs a clean submodule to apply the WASM API patch."
    echo "Either:"
    echo "  • Commit or stash your submodule edits, or"
    echo "  • If these are leftovers from an interrupted build, run:"
    echo "      (cd ghostty && git restore . && git clean -fd)"
    exit 1
fi
cd ..

# Apply patch (optional — skip if empty/missing)
PATCH=patches/ghostty-wasm-api.patch
if [ -s "$PATCH" ]; then
    echo "🔧 Applying WASM API patch..."
    cd ghostty
    git apply --check "../$PATCH" || {
        echo "❌ Patch doesn't apply cleanly"
        echo "Ghostty may have changed. Check $PATCH"
        exit 1
    }
    git apply "../$PATCH"
    cd ..
else
    echo "🔧 No patch to apply (skipping)"
fi

# Build WASM
echo "⚙️  Building WASM (takes ~20 seconds)..."
cd ghostty
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
cd ..

# Copy to project root
cp ghostty/zig-out/bin/ghostty-vt.wasm ./

# Reverse the patch we applied. Don't touch anything else — contributors
# may have generated build artifacts in the submodule that they want to
# keep, and we shouldn't run git restore/clean on a worktree we don't
# fully own.
echo "🧹 Cleaning up..."
cd ghostty
if [ -s "../$PATCH" ]; then
    git apply -R "../$PATCH" 2>/dev/null || {
        echo "⚠️  Couldn't reverse the patch cleanly. The submodule may"
        echo "    need manual cleanup before the next build:"
        echo "      (cd ghostty && git restore . && git clean -fd)"
    }
fi
cd ..

SIZE=$(du -h ghostty-vt.wasm | cut -f1)
echo "✅ Built ghostty-vt.wasm ($SIZE)"
