"""Local YuNet/SFace matching. Features stay private and in memory."""
from pathlib import Path
import cv2
import numpy as np

MATCH_THRESHOLD = .45  # Demo tuning, not a calibrated probability/accuracy.
IDENTITY_MARGIN = .12


def similarity(a, b):
    return float(np.dot(a.ravel(), b.ravel()))


class FaceIdentity:
    def __init__(self, models):
        models = Path(models)
        self.detector = cv2.FaceDetectorYN.create(str(models/'face_detection_yunet_2026may.onnx'), '', (320, 320), .8)
        self.recognizer = cv2.FaceRecognizerSF.create(str(models/'face_recognition_sface_2021dec.onnx'), '')

    def close(self):
        self.detector = self.recognizer = None

    def faces(self, image, minimum=20):
        height, width = image.shape[:2]
        scale = min(1., 960/max(width, height))
        small = cv2.resize(image, (round(width*scale), round(height*scale))) if scale < 1 else image
        self.detector.setInputSize((small.shape[1], small.shape[0]))
        _, rows = self.detector.detect(small)
        result = []
        for row in ([] if rows is None else rows):
            row = row.copy(); row[:14] /= scale
            x, y, w, h = row[:4]
            if min(w, h) < minimum or x < 0 or y < 0 or x+w > width or y+h > height:
                continue
            aligned = self.recognizer.alignCrop(image, row)
            feature = self.recognizer.feature(aligned).astype(np.float32)
            feature /= max(float(np.linalg.norm(feature)), 1e-8)
            result.append((row, feature, aligned))
        return result

    def enroll(self, image):
        faces = self.faces(image, minimum=20)
        if not faces:
            raise ValueError('SELFIE_FACE_NOT_FOUND')
        usable = [f for f in faces if min(f[0][2:4]) >= 80]
        if not usable:
            raise ValueError('SELFIE_TOO_SMALL')
        height, width = image.shape[:2]
        central = [f for f in usable if .2 <= (f[0][0]+f[0][2]/2)/width <= .8 and .08 <= (f[0][1]+f[0][3]/2)/height <= .92]
        if not central:
            raise ValueError('SELFIE_CENTER_FACE')
        central.sort(key=lambda f: float(f[0][2]*f[0][3]), reverse=True)
        if len(central) > 1 and central[0][0][2]*central[0][0][3] < 1.8*central[1][0][2]*central[1][0][3]:
            raise ValueError('SELFIE_MULTIPLE_FACES')
        row, feature, aligned = central[0]
        gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
        if not 30 <= float(gray.mean()) <= 225 or cv2.Laplacian(gray, cv2.CV_64F).var() < 15:
            raise ValueError('SELFIE_POOR_QUALITY')
        return feature

    @staticmethod
    def matches(feature, opponent, own):
        if feature is None or opponent is None:
            return False
        score = similarity(feature, opponent)
        return score >= MATCH_THRESHOLD and (own is None or score-similarity(feature, own) >= IDENTITY_MARGIN)
