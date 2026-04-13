"""
Centralized logging configuration for SCEPMAPS
"""
import os
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


def setup_logging(app_name='scepmaps', log_level=None):
    """
    Configure application logging with both file and console output
    
    Args:
        app_name: Name of the application
        log_level: Logging level (defaults to INFO in production, DEBUG in development)
    """
    # Determine log level
    if log_level is None:
        flask_env = os.getenv('FLASK_ENV', 'production')
        log_level = logging.DEBUG if flask_env == 'development' else logging.INFO
    
    # Create logs directory
    log_dir = Path(__file__).parent / 'logs'
    log_dir.mkdir(exist_ok=True)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # Clear any existing handlers
    root_logger.handlers = []
    
    # Console handler with color-coded output
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)
    console_formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)
    
    # File handler with rotation
    if os.getenv('FLASK_ENV') != 'testing':
        file_handler = RotatingFileHandler(
            log_dir / f'{app_name}.log',
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=10
        )
        file_handler.setLevel(log_level)
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        root_logger.addHandler(file_handler)
    
    # Error log file (errors only)
    if os.getenv('FLASK_ENV') != 'testing':
        error_handler = RotatingFileHandler(
            log_dir / f'{app_name}_errors.log',
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=5
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(file_formatter)
        root_logger.addHandler(error_handler)
    
    # Reduce noise from third-party libraries
    logging.getLogger('urllib3').setLevel(logging.WARNING)
    logging.getLogger('requests').setLevel(logging.WARNING)
    logging.getLogger('werkzeug').setLevel(logging.INFO)
    
    return root_logger


def get_logger(name):
    """
    Get a logger instance for a specific module
    
    Args:
        name: Module name (typically __name__)
    
    Returns:
        logging.Logger: Logger instance
    """
    return logging.getLogger(name)


# Request logging decorator
def log_request(func):
    """Decorator to log API requests"""
    import functools
    from flask import request
    
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        logger = get_logger(func.__module__)
        logger.info(f"Request: {request.method} {request.path} from {request.remote_addr}")
        try:
            result = func(*args, **kwargs)
            logger.info(f"Response: {request.method} {request.path} - Success")
            return result
        except Exception as e:
            logger.error(f"Response: {request.method} {request.path} - Error: {str(e)}", exc_info=True)
            raise
    
    return wrapper


# Performance monitoring decorator
def log_performance(func):
    """Decorator to log function execution time"""
    import functools
    import time
    
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        logger = get_logger(func.__module__)
        start_time = time.time()
        
        try:
            result = func(*args, **kwargs)
            elapsed = time.time() - start_time
            logger.debug(f"{func.__name__} completed in {elapsed:.3f}s")
            return result
        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"{func.__name__} failed after {elapsed:.3f}s: {str(e)}")
            raise
    
    return wrapper

