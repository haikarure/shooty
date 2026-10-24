"""Engineering fixtures from Google's public test assets; never product photos."""
from pathlib import Path
import cv2

ROOT = Path(__file__).resolve().parents[1]/'tests/fixtures/vision'
pose = cv2.imread(str(ROOT/'pose.jpg'))
portrait = cv2.imread(str(ROOT/'portrait.jpg'))
cv2.imwrite(str(ROOT/'selfie-pose.jpg'), cv2.resize(pose[230:325,430:525], (400,400)), [cv2.IMWRITE_JPEG_QUALITY,95])
composite = pose.copy()
composite[256:311,456:498] = cv2.resize(portrait[77:347,305:499],(42,55))
cv2.imwrite(str(ROOT/'pose-portrait-composite.jpg'), composite, [cv2.IMWRITE_JPEG_QUALITY,95])
