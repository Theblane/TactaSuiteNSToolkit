const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

/**
 * Helper to recursively find files with specific extensions
 */
function getFiles(dir, extensions) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(getFiles(file, extensions));
        } else {
            if (extensions.some(ext => file.endsWith(ext))) {
                results.push(file);
            }
        }
    });
    return results;
}

/**
 * Copies static assets to the dist folder
 */
function copyStaticAssets() {
    const assets = [
        { from: 'manifest.json', to: 'dist/manifest.json' },
        { from: 'icons', to: 'dist/icons' },
        { from: 'popup', to: 'dist/popup' },
        { from: 'options', to: 'dist/options' },
        { from: 'shared', to: 'dist/shared' },
        { from: 'content/features', to: 'dist/content/features' }
    ];

    if (!fs.existsSync('dist')) {
        fs.mkdirSync('dist');
    }

    assets.forEach(asset => {
        const src = path.resolve(__dirname, asset.from);
        const dest = path.resolve(__dirname, asset.to);
        
        if (fs.existsSync(src)) {
            // Simple recursive copy
            if (fs.lstatSync(src).isDirectory()) {
                fs.cpSync(src, dest, { recursive: true });
            } else {
                fs.copyFileSync(src, dest);
            }
            console.log(`Copied ${asset.from} to ${asset.to}`);
        }
    });
}

async function runBuild() {
    copyStaticAssets();

    const entryPoints = {
        'background/service-worker': 'src/background/service-worker.ts',
        'content/router': 'src/content/router.ts',
        'content/feature-loader': 'src/content/feature-loader.ts',
        'content/ns-page-detector': 'src/content/ns-page-detector.ts',
        'shared/ns-utils': 'src/shared/ns-utils.ts',
        'shared/storage-utils': 'src/shared/storage-utils.ts',
        'shared/dom-utils': 'src/shared/dom-utils.ts',
        'shared/ns-bridge': 'src/shared/ns-bridge.ts',
        'shared/theme-manager': 'src/shared/theme-manager.ts'
    };

    const ctx = await esbuild.context({
        entryPoints: entryPoints,
        bundle: true,
        outdir: 'dist',
        platform: 'browser',
        target: 'chrome100',
        format: 'iife', // Browser extension scripts usually need IIFE
        sourcemap: isWatch,
        minify: !isWatch,
        define: {
            'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
        },
        loader: {
            '.ts': 'ts'
        }
    });

    if (isWatch) {
        console.log('Watching for changes...');
        await ctx.watch();
    } else {
        console.log('Building for production...');
        await ctx.rebuild();
        await ctx.dispose();
        console.log('Build complete!');
    }
}

runBuild().catch(err => {
    console.error(err);
    process.exit(1);
});
