"""
Monitoring and metrics for SCEPMAPS
"""
import time
import psutil
import os
from collections import defaultdict
from threading import Lock
from datetime import datetime


class MetricsCollector:
    """
    Simple metrics collector for monitoring application health
    """
    
    def __init__(self):
        self.metrics = defaultdict(lambda: {'count': 0, 'total_time': 0, 'errors': 0})
        self.lock = Lock()
        self.start_time = time.time()
    
    def record_request(self, endpoint, duration, error=False):
        """Record a request metric"""
        with self.lock:
            self.metrics[endpoint]['count'] += 1
            self.metrics[endpoint]['total_time'] += duration
            if error:
                self.metrics[endpoint]['errors'] += 1
    
    def record_export(self, export_type, duration, success=True):
        """Record an export operation"""
        key = f'export_{export_type}'
        with self.lock:
            self.metrics[key]['count'] += 1
            self.metrics[key]['total_time'] += duration
            if not success:
                self.metrics[key]['errors'] += 1
    
    def get_metrics(self):
        """Get current metrics snapshot"""
        with self.lock:
            return {
                'uptime': time.time() - self.start_time,
                'endpoints': dict(self.metrics),
                'system': self._get_system_metrics()
            }
    
    def _get_system_metrics(self):
        """Get system resource metrics"""
        process = psutil.Process(os.getpid())
        
        return {
            'cpu_percent': process.cpu_percent(),
            'memory_mb': process.memory_info().rss / 1024 / 1024,
            'memory_percent': process.memory_percent(),
            'threads': process.num_threads(),
            'open_files': len(process.open_files()) if hasattr(process, 'open_files') else 0
        }
    
    def get_summary(self):
        """Get human-readable metrics summary"""
        metrics = self.get_metrics()
        uptime_hours = metrics['uptime'] / 3600
        
        summary = {
            'uptime_hours': round(uptime_hours, 2),
            'total_requests': sum(m['count'] for m in metrics['endpoints'].values()),
            'total_errors': sum(m['errors'] for m in metrics['endpoints'].values()),
            'system': metrics['system']
        }
        
        # Calculate averages
        for endpoint, data in metrics['endpoints'].items():
            if data['count'] > 0:
                avg_time = data['total_time'] / data['count']
                summary[endpoint] = {
                    'count': data['count'],
                    'avg_time_ms': round(avg_time * 1000, 2),
                    'errors': data['errors'],
                    'error_rate': round(data['errors'] / data['count'] * 100, 2)
                }
        
        return summary


# Global metrics collector instance
metrics_collector = MetricsCollector()


def get_health_status():
    """
    Get comprehensive health status
    
    Returns:
        dict: Health status information
    """
    try:
        process = psutil.Process(os.getpid())
        memory_info = process.memory_info()
        
        # Check system resources
        cpu_percent = process.cpu_percent(interval=0.1)
        memory_percent = process.memory_percent()
        
        # Determine health status
        status = 'healthy'
        issues = []
        
        if cpu_percent > 90:
            status = 'degraded'
            issues.append('High CPU usage')
        
        if memory_percent > 90:
            status = 'degraded'
            issues.append('High memory usage')
        
        return {
            'status': status,
            'timestamp': datetime.utcnow().isoformat(),
            'uptime_seconds': time.time() - metrics_collector.start_time,
            'system': {
                'cpu_percent': cpu_percent,
                'memory_mb': memory_info.rss / 1024 / 1024,
                'memory_percent': memory_percent,
                'threads': process.num_threads()
            },
            'issues': issues if issues else None
        }
    except Exception as e:
        return {
            'status': 'unhealthy',
            'error': str(e),
            'timestamp': datetime.utcnow().isoformat()
        }


def monitor_endpoint(func):
    """Decorator to monitor endpoint performance"""
    import functools
    from flask import request
    
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        start_time = time.time()
        error = False
        
        try:
            result = func(*args, **kwargs)
            return result
        except Exception as e:
            error = True
            raise
        finally:
            duration = time.time() - start_time
            endpoint = request.endpoint or 'unknown'
            metrics_collector.record_request(endpoint, duration, error)
    
    return wrapper

