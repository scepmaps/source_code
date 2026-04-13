"""
Database migration utilities for SCEPMAPS

Simple migration system for schema changes without full Alembic setup.
For more complex migrations, consider using Alembic.
"""
import os
import sqlite3
from pathlib import Path
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class MigrationManager:
    """
    Simple database migration manager
    """
    
    def __init__(self, db_path=None):
        if db_path is None:
            db_path = os.getenv('DATABASE_URL', 'users.db')
            if db_path.startswith('sqlite:///'):
                db_path = db_path.replace('sqlite:///', '')
        
        self.db_path = db_path
        self.migrations_dir = Path(__file__).parent / 'migrations'
        self.migrations_dir.mkdir(exist_ok=True)
    
    def get_connection(self):
        """Get database connection"""
        return sqlite3.connect(self.db_path)
    
    def init_migrations_table(self):
        """Create migrations tracking table"""
        conn = self.get_connection()
        try:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version TEXT NOT NULL UNIQUE,
                    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    description TEXT
                )
            ''')
            conn.commit()
        finally:
            conn.close()
    
    def get_applied_migrations(self):
        """Get list of applied migrations"""
        conn = self.get_connection()
        try:
            cursor = conn.execute('SELECT version FROM schema_migrations ORDER BY version')
            return [row[0] for row in cursor.fetchall()]
        except sqlite3.OperationalError:
            # Migrations table doesn't exist yet
            return []
        finally:
            conn.close()
    
    def apply_migration(self, version, description, sql):
        """Apply a migration"""
        conn = self.get_connection()
        try:
            # Execute migration SQL
            conn.executescript(sql)
            
            # Record migration
            conn.execute(
                'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
                (version, description)
            )
            conn.commit()
            logger.info(f"Applied migration {version}: {description}")
            return True
        except Exception as e:
            conn.rollback()
            logger.error(f"Failed to apply migration {version}: {e}")
            return False
        finally:
            conn.close()
    
    def rollback_migration(self, version):
        """Mark a migration as rolled back (doesn't execute rollback SQL)"""
        conn = self.get_connection()
        try:
            conn.execute('DELETE FROM schema_migrations WHERE version = ?', (version,))
            conn.commit()
            logger.info(f"Rolled back migration {version}")
        finally:
            conn.close()
    
    def get_pending_migrations(self):
        """Get list of pending migrations"""
        applied = set(self.get_applied_migrations())
        
        # Find migration files
        migration_files = sorted(self.migrations_dir.glob('*.sql'))
        
        pending = []
        for filepath in migration_files:
            version = filepath.stem
            if version not in applied:
                pending.append((version, filepath))
        
        return pending
    
    def run_migrations(self):
        """Run all pending migrations"""
        self.init_migrations_table()
        
        pending = self.get_pending_migrations()
        
        if not pending:
            logger.info("No pending migrations")
            return True
        
        logger.info(f"Found {len(pending)} pending migrations")
        
        for version, filepath in pending:
            logger.info(f"Applying migration: {version}")
            
            # Read migration file
            with open(filepath, 'r') as f:
                sql = f.read()
            
            # Extract description from first comment line
            description = version
            for line in sql.split('\n'):
                if line.strip().startswith('--'):
                    description = line.strip()[2:].strip()
                    break
            
            if not self.apply_migration(version, description, sql):
                logger.error(f"Migration {version} failed, stopping")
                return False
        
        logger.info("All migrations applied successfully")
        return True
    
    def create_migration(self, name):
        """Create a new migration file"""
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        version = f"{timestamp}_{name}"
        filepath = self.migrations_dir / f"{version}.sql"
        
        template = f"""-- {name}
-- Created: {datetime.now().isoformat()}

-- Add your SQL statements here
-- Example:
-- ALTER TABLE users ADD COLUMN new_field TEXT;

-- Remember: SQLite has limited ALTER TABLE support
-- For complex changes, you may need to:
--   1. Create new table with desired schema
--   2. Copy data from old table
--   3. Drop old table
--   4. Rename new table
"""
        
        with open(filepath, 'w') as f:
            f.write(template)
        
        logger.info(f"Created migration file: {filepath}")
        print(f"Created migration: {filepath}")
        print("Edit the file and add your SQL statements")
        
        return filepath


# Example migration files to create

EXAMPLE_MIGRATIONS = {
    '20250101000000_add_user_preferences': """-- Add user preferences column
-- Created: 2025-01-01

-- Add preferences JSON column to users table
ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}';
""",
    
    '20250101000001_add_export_metadata': """-- Add export metadata tracking
-- Created: 2025-01-01

-- Add more detailed export tracking
ALTER TABLE export_log ADD COLUMN bbox TEXT;
ALTER TABLE export_log ADD COLUMN zoom INTEGER;
ALTER TABLE export_log ADD COLUMN crs TEXT;
"""
}


def create_example_migrations():
    """Create example migration files for reference"""
    manager = MigrationManager()
    
    for name, sql in EXAMPLE_MIGRATIONS.items():
        filepath = manager.migrations_dir / f"{name}.sql.example"
        if not filepath.exists():
            with open(filepath, 'w') as f:
                f.write(sql)
            logger.info(f"Created example migration: {filepath}")


if __name__ == '__main__':
    # CLI interface
    import sys
    
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python migrations.py run              - Run pending migrations")
        print("  python migrations.py create <name>    - Create new migration")
        print("  python migrations.py status           - Show migration status")
        print("  python migrations.py examples         - Create example migrations")
        sys.exit(1)
    
    command = sys.argv[1]
    manager = MigrationManager()
    
    if command == 'run':
        manager.run_migrations()
    
    elif command == 'create':
        if len(sys.argv) < 3:
            print("Error: migration name required")
            sys.exit(1)
        name = sys.argv[2]
        manager.create_migration(name)
    
    elif command == 'status':
        applied = manager.get_applied_migrations()
        pending = manager.get_pending_migrations()
        
        print(f"Applied migrations: {len(applied)}")
        for version in applied:
            print(f"  ✓ {version}")
        
        print(f"\nPending migrations: {len(pending)}")
        for version, _ in pending:
            print(f"  ○ {version}")
    
    elif command == 'examples':
        create_example_migrations()
        print("Created example migration files in source_code/server/migrations/")
    
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

