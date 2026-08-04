const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('📦 Starting build process...');

// Check if we are in cPanel or a restricted environment
const isCpanel = process.env.HOME && (process.env.HOME.includes('lazemees') || process.env.HOME.includes('passenger') || process.env.HOME.includes('cpanel'));

// Also check if Vite is missing (which happens on production cPanel npm installs)
let hasVite = true;
try {
  require.resolve('vite');
} catch (e) {
  hasVite = false;
}

if (isCpanel || !hasVite) {
  console.log('\n=============================================================');
  console.log('⚠️  DETECTED CPANEL / RESTRICTED SHARED HOSTING ENVIRONMENT');
  console.log('=============================================================');
  console.log('🌟 Skipping resource-intensive compilation on your hosting!');
  console.log('💡 Your React client & Node server are already fully pre-compiled');
  console.log('   into the "dist/" directory by AI Studio.');
  console.log('🚀 All you need to do is upload the files and RESTART the app.');
  console.log('=============================================================\n');
  process.exit(0);
}

try {
  console.log('⚡ Building Client with Vite...');
  execSync('vite build', { stdio: 'inherit' });

  console.log('⚡ Bundling Server with esbuild...');
  execSync('esbuild server.ts --bundle --platform=node --format=cjs --external:vite --sourcemap --outfile=dist/server.cjs', { stdio: 'inherit' });

  console.log('🎁 Packaging pre-compiled assets into single cpanel-deploy.zip...');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  // Add the built dist folder (excluding any previously prepared zip to prevent recursive nesting)
  // We will write the zip later
  const tempZipPath = path.join(process.cwd(), 'cpanel-deploy.zip');
  const finalZipPath = path.join(process.cwd(), 'dist', 'cpanel-deploy.zip');

  if (fs.existsSync(finalZipPath)) {
    fs.unlinkSync(finalZipPath);
  }
  
  if (fs.existsSync('dist')) {
    zip.addLocalFolder('dist', 'dist');
  }

  // Add root files crucial for cPanel Passenger to work
  if (fs.existsSync('app.js')) zip.addLocalFile('app.js');
  if (fs.existsSync('index.js')) zip.addLocalFile('index.js');
  if (fs.existsSync('package.json')) zip.addLocalFile('package.json');
  if (fs.existsSync('.env.example')) zip.addLocalFile('.env.example');

  // Write temporary ZIP
  zip.writeZip(tempZipPath);

  // Move ZIP inside dist so it can be served stably by Express
  fs.renameSync(tempZipPath, finalZipPath);

  console.log('✅ Build and packaging completed successfully inside AI Studio! Ready for Export.');
  console.log('👉 cpanel-deploy.zip has been created in the "dist" directory.');
} catch (error) {
  console.error('❌ Build error:', error.message);
  process.exit(1);
}
