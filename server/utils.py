from pyproj import Transformer

# Simple cached transformers
_tr_4326_to_3857 = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)
_tr_3857_to_4326 = Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)

def bbox_4326_to_3857(bbox):
    w, s, e, n = bbox
    x_min, y_min = _tr_4326_to_3857.transform(w, s)
    x_max, y_max = _tr_4326_to_3857.transform(e, n)
    return (min(x_min, x_max), min(y_min, y_max), max(x_min, x_max), max(y_min, y_max))


def bbox_3857_to_4326(bbox):
    x_min, y_min, x_max, y_max = bbox
    w, s = _tr_3857_to_4326.transform(x_min, y_min)
    e, n = _tr_3857_to_4326.transform(x_max, y_max)
    return (min(w, e), min(s, n), max(w, e), max(s, n))