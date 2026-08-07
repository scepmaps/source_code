# source_code/server/config.py - Production Configuration
import os
from pathlib import Path

class Config:
    """Base configuration"""
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-change-in-production')
    
    # Database
    DATABASE_URL = os.getenv('DATABASE_URL', str(Path(__file__).parent / 'users.db'))
    
    # External APIs
    OPENAIP_KEY = os.getenv('OPENAIP_KEY', '')
    ARCGIS_API_KEY = os.getenv('ARCGIS_API_KEY', '')
    SHOM_REFERER = os.getenv('SHOM_REFERER', 'https://data.shom.fr/')
    
    # CORS settings — comma-separated origins; never default to '*' in production
    _cors_raw = os.getenv('CORS_ORIGINS', '*')
    CORS_ORIGINS = [o.strip() for o in _cors_raw.split(',') if o.strip()]
    
    # Rate limiting
    RATELIMIT_STORAGE_URL = os.getenv('RATELIMIT_STORAGE_URL', 'memory://')
    
    # Export settings
    MAX_EXPORT_SIZE = int(os.getenv('MAX_EXPORT_SIZE', '4096'))
    EXPORT_TIMEOUT = int(os.getenv('EXPORT_TIMEOUT', '300'))  # 5 minutes
    
    # Security
    JWT_EXPIRY_HOURS = int(os.getenv('JWT_EXPIRY_HOURS', '24'))
    BCRYPT_ROUNDS = int(os.getenv('BCRYPT_ROUNDS', '12'))
    
    # Tile proxy settings
    TILE_CACHE_SIZE = int(os.getenv('TILE_CACHE_SIZE', '100'))  # MB
    TILE_CACHE_TTL = int(os.getenv('TILE_CACHE_TTL', '3600'))  # seconds
    
    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    LOG_TO_FILE = os.getenv('LOG_TO_FILE', 'true').lower() == 'true'
    
    # Monitoring
    ENABLE_METRICS = os.getenv('ENABLE_METRICS', 'true').lower() == 'true'
    SENTRY_DSN = os.getenv('SENTRY_DSN', '')

class DevelopmentConfig(Config):
    """Development configuration"""
    DEBUG = True
    CORS_ORIGINS = ['http://localhost:8000', 'http://127.0.0.1:8000']

class ProductionConfig(Config):
    """Production configuration"""
    DEBUG = False
    # Override with production values
    SECRET_KEY = os.getenv('SECRET_KEY')  # Must be set in production
    
    # Stricter CORS in production (empty/missing → no wildcard)
    _prod_cors = os.getenv('CORS_ORIGINS', '')
    CORS_ORIGINS = [o.strip() for o in _prod_cors.split(',') if o.strip() and o.strip() != '*']
    
    # Enhanced security
    BCRYPT_ROUNDS = 14

class TestingConfig(Config):
    """Testing configuration"""
    TESTING = True
    DATABASE_URL = ':memory:'

# Configuration mapping
config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}

