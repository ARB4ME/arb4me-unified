const bcrypt = require('bcrypt');

// Generate hash for initial admin password
async function generateAdminPasswordHash() {
    const password = 'Master@ARB4ME2025';
    const saltRounds = 12;
    
    try {
        const hash = await bcrypt.hash(password, saltRounds);
        console.log('Password:', password);
        console.log('Hash:', hash);
        console.log('\nUse this hash in the migration file for admin_password_hash');
        
        // Test the hash
        const isValid = await bcrypt.compare(password, hash);
        console.log('Hash validation:', isValid ? '✅ Valid' : '❌ Invalid');
    } catch (error) {
        console.error('Error generating hash:', error);
    }
}

generateAdminPasswordHash();