"""
Enhanced health check endpoint with detailed diagnostics
"""
import os
import sqlite3
from pathlib import Path
from monitoring import get_health_status, metrics_collector


def check_database():
    """Check database connectivity"""
    try:
        db_path = os.getenv('DATABASE_URL', 'users.db')
        if db_path.startswith('sqlite:///'):
            db_path = db_path.replace('sqlite:///', '')
        
        if not Path(db_path).exists():
            return {'status': 'warning', 'message': 'Database file not found'}
        
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute('SELECT 1')
        conn.close()
        
        return {'status': 'ok', 'message': 'Database accessible'}
    except Exception as e:
        return {'status': 'error', 'message': f'Database error: {str(e)}'}


def check_disk_space():
    """Check available disk space"""
    try:
        import shutil
        total, used, free = shutil.disk_usage('/')
        free_gb = free / (1024 ** 3)
        percent_free = (free / total) * 100
        
        if percent_free < 10:
            return {
                'status': 'critical',
                'free_gb': round(free_gb, 2),
                'percent_free': round(percent_free, 2)
            }
        elif percent_free < 20:
            return {
                'status': 'warning',
                'free_gb': round(free_gb, 2),
                'percent_free': round(percent_free, 2)
            }
        else:
            return {
                'status': 'ok',
                'free_gb': round(free_gb, 2),
                'percent_free': round(percent_free, 2)
            }
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


def check_playwright():
    """Check if Playwright is properly installed"""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
        return {'status': 'ok', 'message': 'Playwright working'}
    except Exception as e:
        return {'status': 'error', 'message': f'Playwright error: {str(e)}'}


def get_detailed_health():
    """
    Get detailed health check information
    
    Returns:
        dict: Comprehensive health status
    """
    health = get_health_status()
    
    # Add component checks
    health['components'] = {
        'database': check_database(),
        'disk': check_disk_space(),
        'playwright': check_playwright()
    }
    
    # Add metrics summary
    if os.getenv('ENABLE_METRICS', 'true').lower() == 'true':
        health['metrics'] = metrics_collector.get_summary()
    
    # Determine overall status based on component health
    component_statuses = [c['status'] for c in health['components'].values()]
    if 'error' in component_statuses or 'critical' in component_statuses:
        health['status'] = 'unhealthy'
    elif 'warning' in component_statuses:
        health['status'] = 'degraded'
    
    return health



