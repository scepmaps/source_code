#!/usr/bin/env python3
"""
SCEPMAPS - Production Web Application
GeoTIFF Map Export Service with User Management
"""

import os
import logging
from pathlib import Path
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

# Import existing modules
from db import init_db, ensure_default_admin
from auth import hash_password
from config import config

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def create_app(config_name=None):
    """Application factory pattern"""
    if config_name is None:
        config_name = os.getenv('FLASK_ENV', 'production')
    
    app = Flask(__name__)
    app.config.from_object(config[config_name])
    
    # Handle reverse proxy headers
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    
    # Setup CORS
    CORS(app, origins=app.config['CORS_ORIGINS'])
    
    # Security headers
    @app.after_request
    def security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['X-XSS-Protection'] = '1; mode=block'
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
            "img-src 'self' data: https: blob:; "
            "font-src 'self' https://fonts.gstatic.com; "
            "connect-src 'self';"
        )
        return response
    
    # Error handlers
    @app.errorhandler(400)
    def bad_request(error):
        return jsonify({'error': 'Bad request'}), 400
    
    @app.errorhandler(401)
    def unauthorized(error):
        return jsonify({'error': 'Unauthorized'}), 401
    
    @app.errorhandler(403)
    def forbidden(error):
        return jsonify({'error': 'Forbidden'}), 403
    
    @app.errorhandler(404)
    def not_found(error):
        return jsonify({'error': 'Not found'}), 404
    
    @app.errorhandler(429)
    def ratelimit_handler(error):
        return jsonify({'error': 'Rate limit exceeded'}), 429
    
    @app.errorhandler(500)
    def internal_error(error):
        logger.error(f"Internal server error: {error}")
        return jsonify({'error': 'Internal server error'}), 500
    
    # Health check
    @app.route('/health')
    def health_check():
        return jsonify({
            'status': 'healthy',
            'version': '1.0.0',
            'environment': config_name
        })
    
    # Import and register routes from existing app.py
    # (We'll need to refactor the existing routes into blueprints)
    
    # Initialize database
    with app.app_context():
        init_db()
        # Ensure default admin exists
        admin_email = os.getenv('ADMIN_EMAIL', 'admin@scepmaps.local')
        admin_password = os.getenv('ADMIN_PASSWORD', 'admin123')
        ensure_default_admin(admin_email, hash_password(admin_password))
        logger.info(f"Default admin: {admin_email}")
    
    return app

if __name__ == '__main__':
    app = create_app()
    port = int(os.getenv('PORT', 5001))
    host = os.getenv('HOST', '0.0.0.0')
    debug = os.getenv('FLASK_ENV') == 'development'
    
    logger.info(f"Starting SCEPMAPS server on {host}:{port}")
    app.run(host=host, port=port, debug=debug)

