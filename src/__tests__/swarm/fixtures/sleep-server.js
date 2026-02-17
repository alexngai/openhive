#!/usr/bin/env node
// Simple test fixture: stays alive and optionally prints output
// Used by LocalProvider tests as a stand-in for OpenSwarm

const mode = process.argv.find(a => a === '--verbose');

if (mode) {
  console.log('hello from swarm');
  console.error('err msg');
  for (let i = 0; i < 10; i++) {
    console.log('line' + i);
  }
}

// Stay alive for 60 seconds
setTimeout(() => {
  process.exit(0);
}, 60000);
