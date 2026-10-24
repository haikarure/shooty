"""Local pose inference and short-lived, user-selected target association.

Selfie face matching confirms a target before short-term body tracking.
Raw frames and face/body features aren't written to disk by this service.
"""
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
import time

import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import numpy as np
from PIL import Image
from .face_identity import FaceIdentity


MAX_FRAME_BYTES = 262144
MIN_VISIBILITY = .65


def inside_polygon(point, vertices):
    if len(vertices) < 3:
        return False
    return cv2.pointPolygonTest(np.array(vertices, np.float32), point, False) >= 0


def in_ellipse(point, ellipse):
    return ((point[0]-ellipse["cx"])/ellipse["rx"])**2 + ((point[1]-ellipse["cy"])/ellipse["ry"])**2 <= 1


def in_capsule(point, capsule, width, height):
    p = np.array(point)*[width, height]
    a, b = np.array(capsule["a"])*[width, height], np.array(capsule["b"])*[width, height]
    segment = b-a
    along = np.clip(np.dot(p-a, segment)/max(np.dot(segment, segment), 1e-8), 0, 1)
    return np.linalg.norm(p-(a+along*segment)) <= capsule["r"]*width


@dataclass
class Candidate:
    public: dict
    descriptor: np.ndarray = field(repr=False)
    mask: np.ndarray = field(repr=False)
    face_feature: np.ndarray | None = field(default=None, repr=False)
    face_matches: bool = False
    nose: tuple | None = field(default=None, repr=False)

    def hit(self, point, width, height):
        x, y = point
        if not (0 <= x < 1 and 0 <= y < 1):
            return "MISS"
        mh, mw = self.mask.shape[:2]
        if float(self.mask[min(int(y*mh), mh-1), min(int(x*mw), mw-1)]) < .7:
            return "MISS"
        if self.public["head"] and in_ellipse(point, self.public["head"]):
            return "HEAD"
        if inside_polygon(point, self.public["body"]) or any(in_capsule(point, limb, width, height) for limb in self.public["limbs"]):
            return "BODY"
        return "MISS"


@dataclass
class Analysis:
    width: int
    height: int
    candidates: list
    elapsed_ms: float


class VisionEngine:
    def __init__(self, models):
        self.pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(Path(models)/"pose_landmarker_lite.task")),
            running_mode=vision.RunningMode.IMAGE, num_poses=3,
            min_pose_detection_confidence=.6, min_pose_presence_confidence=.65,
            output_segmentation_masks=True))
        try:
            self.identity = FaceIdentity(models)
        except Exception:
            self.pose.close()
            raise

    def close(self):
        self.identity.close()
        self.pose.close()

    @staticmethod
    def decode(encoded):
        if not 100 <= len(encoded) <= MAX_FRAME_BYTES or not encoded.startswith(b"\xff\xd8"):
            raise ValueError("INVALID_FRAME")
        with Image.open(BytesIO(encoded)) as header:
            width, height = header.size
            if header.format != "JPEG" or width < 160 or height < 120 or width*height > 1500000 or max(width, height) > 1600:
                raise ValueError("INVALID_FRAME_DIMENSIONS")
        bgr = cv2.imdecode(np.frombuffer(encoded, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("INVALID_FRAME")
        return bgr

    def enroll(self, encoded):
        return self.identity.enroll(self.decode(encoded))

    def analyze(self, encoded):
        start = time.perf_counter()
        original = self.decode(encoded)
        bgr = original
        height, width = bgr.shape[:2]
        if max(width, height) > 640:
            scale = 640/max(width, height)
            bgr = cv2.resize(bgr, (round(width*scale), round(height*scale)))
        height, width = bgr.shape[:2]
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        poses = self.pose.detect(image)
        candidates = []
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        for index, landmarks in enumerate(poses.pose_landmarks):
            def visible(i):
                p = landmarks[i]
                return min(p.visibility or 0, p.presence or 0) >= MIN_VISIBILITY and 0 <= p.x <= 1 and 0 <= p.y <= 1
            def xy(i):
                return [float(landmarks[i].x), float(landmarks[i].y)]
            if not all(visible(i) for i in (11, 12)):
                continue
            shoulder_px = float(np.linalg.norm((np.array(xy(11))-xy(12))*[width, height]))
            if shoulder_px < 24:
                continue
            if all(visible(i) for i in (23, 24)):
                body = [xy(i) for i in (11, 12, 24, 23)]
            else:
                # A close head/upper-body view needn't include the hips. Keep a
                # conservative chest strip, clipped by the actual person mask.
                a, b = np.array(xy(11))*[width,height], np.array(xy(12))*[width,height]
                axis = (b-a)/shoulder_px
                down = np.array([-axis[1],axis[0]])
                away = (a+b)/2-np.array(xy(0))*[width,height] if visible(0) else np.array([0,1])
                if np.dot(down,away) < 0: down = -down
                lower_a = np.clip((a+down*shoulder_px*.65)/[width,height],0,1)
                lower_b = np.clip((b+down*shoulder_px*.65)/[width,height],0,1)
                body = [xy(11),xy(12),lower_b.tolist(),lower_a.tolist()]
            if abs(cv2.contourArea(np.array(body, np.float32))) < .003:
                continue
            limb_radius = max(5., shoulder_px*.10)/width
            limbs = [{"a": xy(a), "b": xy(b), "r": limb_radius} for a, b in ((11, 13), (13, 15), (12, 14), (14, 16), (23, 25), (25, 27), (24, 26), (26, 28)) if visible(a) and visible(b)]
            major = [xy(i) for i in (0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28) if visible(i)]
            xs, ys = zip(*major)
            bounds = [max(0., min(xs)-.035), max(0., min(ys)-.035), min(1., max(xs)+.035), min(1., max(ys)+.035)]
            head, face_feature = None, None
            if all(visible(i) for i in (0, 2, 5)):
                nose = xy(0)
                side = max(48., shoulder_px*1.6)
                nx, ny = nose[0]*width, nose[1]*height
                x1, y1 = max(0, int(nx-side/2)), max(0, int(ny-side*.6))
                x2, y2 = min(width, int(nx+side/2)), min(height, int(ny+side*.4))
                oh, ow = original.shape[:2]
                ox1, oy1 = round(x1*ow/width), round(y1*oh/height)
                ox2, oy2 = round(x2*ow/width), round(y2*oh/height)
                crop = cv2.resize(original[oy1:oy2, ox1:ox2], (256, 256))
                faces = self.identity.faces(crop)
                choices = []
                for row, feature, _ in faces:
                    left, top = (x1+row[0]*(x2-x1)/256)/width, (y1+row[1]*(y2-y1)/256)/height
                    fw, fh = row[2]*(x2-x1)/256/width, row[3]*(y2-y1)/256/height
                    if min(fw*width, fh*height) < 12:
                        continue
                    if left-.1*fw <= nose[0] <= left+1.1*fw and top-.1*fh <= nose[1] <= top+1.1*fh:
                        cx, cy = left+fw/2, top+fh/2
                        choices.append(({"cx": float(cx), "cy": float(cy), "rx": float(fw*.43), "ry": float(fh*.45)}, feature))
                if len(choices) == 1:
                    head, face_feature = choices[0]
            torso_mask = np.zeros((height, width), np.uint8)
            cv2.fillConvexPoly(torso_mask, (np.array(body)*[width, height]).astype(np.int32), 255)
            torso_mask = cv2.erode(torso_mask, np.ones((5, 5), np.uint8))
            histogram = cv2.calcHist([hsv], [0, 1], torso_mask, [16, 8], [0, 180, 0, 256])
            histogram /= max(float(histogram.sum()), 1.)
            mask = poses.segmentation_masks[index].numpy_view().squeeze().copy() if poses.segmentation_masks else np.zeros((height, width), np.float32)
            candidates.append(Candidate({"id": index, "body": body, "head": head, "limbs": limbs,
                                         "bounds": bounds, "score": round(min(landmarks[i].visibility for i in (11, 12)), 3)}, histogram, mask, face_feature, nose=tuple(xy(0))))
        # Face identity acquisition also works when only the head is visible.
        # A head-only observation has no body damage zone. Ambiguous face/body
        # association never attaches that face identity to an arbitrary torso.
        oh, ow = original.shape[:2]
        for row, feature, _ in self.identity.faces(original, minimum=20):
            x, y, fw, fh = row[:4]/[ow,oh,ow,oh]
            head = {'cx':float(x+fw/2),'cy':float(y+fh/2),'rx':float(fw*.43),'ry':float(fh*.45)}
            if any(c.public['head'] and in_ellipse((head['cx'],head['cy']),c.public['head']) for c in candidates):
                continue
            choices = [c for c in candidates if c.nose and x-fw*.2 <= c.nose[0] <= x+fw*1.2 and y-fh*.2 <= c.nose[1] <= y+fh*1.2]
            if len(choices) == 1:
                c = choices[0]; c.public['head'] = head; c.face_feature = feature
                old = c.public['bounds']; c.public['bounds'] = [float(min(old[0],x)),float(min(old[1],y)),float(max(old[2],x+fw)),float(max(old[3],y+fh))]
            else:
                mask = np.zeros((height,width),np.float32)
                cv2.rectangle(mask,(max(0,int(x*width)),max(0,int(y*height))),(min(width-1,int((x+fw)*width)),min(height-1,int((y+fh)*height))),1.,-1)
                descriptor = np.zeros((16,8),np.float32)
                candidates.append(Candidate({'id':-len(candidates)-1,'body':[],'head':head,'limbs':[],
                    'bounds':[float(x),float(y),float(x+fw),float(y+fh)],'score':float(row[-1])},descriptor,mask,feature))
        return Analysis(width, height, candidates, round((time.perf_counter()-start)*1000, 1))


class TargetTracker:
    """Short-term association with the selected torso, not biometric identity."""
    def __init__(self):
        self.descriptor = None
        self.bounds = None
        self.last_seen = None
        self.invalid = True
        self.reacquire = None

    def lock(self, candidate, now):
        self.descriptor = candidate.descriptor.copy()
        self.bounds = candidate.public["bounds"][:]
        self.last_seen = now
        self.invalid = False
        self.reacquire = None

    def select(self, candidates, now):
        if self.invalid or self.last_seen is None:
            return None
        missing = now-self.last_seen > 1500
        old = self.bounds
        center = np.array([(old[0]+old[2])/2, (old[1]+old[3])/2])
        old_area = max((old[2]-old[0])*(old[3]-old[1]), 1e-5)
        choices = []
        for candidate in candidates:
            bounds = candidate.public["bounds"]
            position = np.array([(bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2])
            distance = float(np.linalg.norm(position-center))
            area = (bounds[2]-bounds[0])*(bounds[3]-bounds[1])
            color = cv2.compareHist(self.descriptor, candidate.descriptor, cv2.HISTCMP_BHATTACHARYYA)
            if missing:
                if color <= .25 and .2 <= area/old_area <= 5:
                    choices.append((color, candidate))
            elif color <= .55 and distance <= .25 and .3 <= area/old_area <= 3:
                choices.append((color*.75+distance*.25, candidate))
        choices.sort(key=lambda item: item[0])
        if not choices or (len(choices) > 1 and choices[1][0]-choices[0][0] < .10):
            self.reacquire = None
            return None
        selected = choices[0][1]
        if missing:
            # Keep the explicit opponent choice while the player uses the menu.
            # A missing track cannot hit; require three consistent observations
            # before recovering it. Similar clothing can still confuse this demo.
            bounds = selected.public["bounds"]
            position = np.array([(bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2])
            previous = self.reacquire
            consistent = previous is not None and now-previous[0] <= 1000 and np.linalg.norm(position-previous[1]) <= .1 and cv2.compareHist(previous[2], selected.descriptor, cv2.HISTCMP_BHATTACHARYYA) <= .2
            count = previous[3]+1 if consistent else 1
            self.reacquire = (now, position, selected.descriptor.copy(), count)
            if count < 3:
                return None
        self.reacquire = None
        self.bounds = selected.public["bounds"][:]
        self.last_seen = now
        return selected


class FaceTargetTracker(TargetTracker):
    """Face-confirmed acquisition, then continuous short-term body association."""
    def __init__(self):
        super().__init__()
        self.pending_face = None

    def select(self, candidates, now):
        matching = [c for c in candidates if c.face_matches]
        if len(matching) > 1:
            self.invalid, self.pending_face = True, None
            return None
        stale = self.invalid or self.last_seen is None or now-self.last_seen > 1500
        if matching:
            candidate = matching[0]
            if not stale and super().select([candidate], now) is candidate:
                self.pending_face = None
                return candidate
            bounds = candidate.public['bounds']
            center = np.array([(bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2])
            prior = self.pending_face
            consistent = prior is not None and now-prior[0] <= 1200 and np.linalg.norm(center-prior[1]) < .12
            self.pending_face = (now, center)
            if consistent:
                self.lock(candidate, now)
                self.pending_face = None
                return candidate
            self.invalid = True
            return None
        self.pending_face = None
        if stale:
            self.invalid = True
            return None
        # A visible unmatched face cannot inherit the opponent's track.
        return super().select([c for c in candidates if c.face_feature is None], now)
