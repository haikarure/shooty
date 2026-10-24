"""Actual pretrained model checks on Google's public MediaPipe test image."""
from pathlib import Path
import unittest
import cv2
import numpy as np
from server.vision_engine import VisionEngine, TargetTracker, FaceTargetTracker, Candidate
from server.face_identity import FaceIdentity, similarity

ROOT = Path(__file__).resolve().parents[1]


class VisionEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = VisionEngine(ROOT/"web/models")
        cls.frame = (ROOT/"tests/fixtures/vision/pose.jpg").read_bytes()

    @classmethod
    def tearDownClass(cls): cls.engine.close()

    def test_real_model_finds_body_head_and_clipped_hit_zones(self):
        analysis = self.engine.analyze(self.frame)
        self.assertEqual(len(analysis.candidates), 1)
        target = analysis.candidates[0]
        self.assertIsNotNone(target.public["head"])
        torso = np.mean(target.public["body"], axis=0)
        self.assertEqual(target.hit(torso, analysis.width, analysis.height), "BODY")
        head = target.public["head"]
        self.assertEqual(target.hit((head["cx"], head["cy"]), analysis.width, analysis.height), "HEAD")
        self.assertEqual(target.hit((.05, .05), analysis.width, analysis.height), "MISS")

    def test_tracking_requires_selection_and_rechecks_missing_or_ambiguous_targets(self):
        analysis = self.engine.analyze(self.frame)
        target = analysis.candidates[0]
        tracker = TargetTracker()
        self.assertIsNone(tracker.select(analysis.candidates, 0))
        tracker.lock(target, 0)
        self.assertIs(tracker.select([target], 100), target)
        duplicate = Candidate(dict(target.public), target.descriptor.copy(), target.mask)
        self.assertIsNone(tracker.select([target, duplicate], 200))
        self.assertIsNone(tracker.select([target], 2000))
        self.assertFalse(tracker.invalid)
        self.assertIsNone(tracker.select([target], 2200))
        self.assertIs(tracker.select([target], 2400), target)
        self.assertIsNone(tracker.select([], 4500))
        self.assertIsNone(tracker.select([target], 4700))
        self.assertIsNone(tracker.select([target, duplicate], 4900))
        self.assertIsNone(tracker.select([target], 5100))

    def test_invalid_and_empty_frames_do_not_create_people(self):
        with self.assertRaises(ValueError): self.engine.analyze(b"not a jpeg")
        _, blank = cv2.imencode('.jpg', np.zeros((360, 640, 3), np.uint8))
        self.assertEqual(self.engine.analyze(blank.tobytes()).candidates, [])

    def test_selfie_features_match_the_same_face_but_not_another_fixture_face(self):
        own = self.engine.enroll((ROOT/'tests/fixtures/vision/portrait.jpg').read_bytes())
        opponent = self.engine.enroll((ROOT/'tests/fixtures/vision/selfie-pose.jpg').read_bytes())
        target = self.engine.analyze(self.frame).candidates[0]
        self.assertTrue(FaceIdentity.matches(target.face_feature, opponent, own))
        self.assertFalse(FaceIdentity.matches(target.face_feature, own, opponent))
        self.assertFalse(FaceIdentity.matches(target.face_feature, opponent, opponent))
        self.assertLess(similarity(own, opponent), .65)
        with self.assertRaisesRegex(ValueError, 'SELFIE_TOO_SMALL'): self.engine.enroll(self.frame)

    def test_face_confirmed_tracking_rejects_wrong_faces_and_rechecks_after_a_gap(self):
        target = self.engine.analyze(self.frame).candidates[0]
        target.face_matches = True
        tracker = FaceTargetTracker()
        self.assertIsNone(tracker.select([target], 0))
        self.assertIs(tracker.select([target], 200), target)
        hidden_face = Candidate(target.public, target.descriptor, target.mask)
        self.assertIs(tracker.select([hidden_face], 400), hidden_face)
        wrong_face = Candidate(target.public, target.descriptor, target.mask, target.face_feature)
        self.assertIsNone(tracker.select([wrong_face], 600))
        self.assertIsNone(tracker.select([hidden_face], 2100))
        self.assertIsNone(tracker.select([target], 2300))
        self.assertIs(tracker.select([target], 2500), target)
        self.assertIsNone(tracker.select([target, target], 2700))

    def test_close_face_can_be_recognized_and_hit_without_visible_hips(self):
        portrait = cv2.imread(str(ROOT/'tests/fixtures/vision/portrait.jpg'))
        encoded = cv2.imencode('.jpg', portrait[35:410,240:600])[1].tobytes()
        analysis = self.engine.analyze(encoded)
        self.assertEqual(len(analysis.candidates), 1)
        target = analysis.candidates[0]
        reference = self.engine.enroll((ROOT/'tests/fixtures/vision/portrait.jpg').read_bytes())
        self.assertTrue(FaceIdentity.matches(target.face_feature, reference, None))
        head = target.public['head']
        self.assertEqual(target.hit((head['cx'], head['cy']), analysis.width, analysis.height), 'HEAD')
        self.assertEqual(target.hit((.01,.99), analysis.width, analysis.height), 'MISS')

    def test_selfie_ignores_small_background_faces_but_rejects_two_equal_subjects(self):
        portrait = cv2.imread(str(ROOT/'tests/fixtures/vision/portrait.jpg'))
        foreground = cv2.resize(portrait,(480,600))
        canvas = np.zeros((720,960,3),np.uint8)
        canvas[60:660,240:720] = foreground
        canvas[20:180,20:180] = cv2.resize(cv2.imread(str(ROOT/'tests/fixtures/vision/selfie-pose.jpg')),(160,160))
        reference = self.engine.enroll(cv2.imencode('.jpg',portrait)[1].tobytes())
        chosen = self.engine.enroll(cv2.imencode('.jpg',canvas)[1].tobytes())
        self.assertGreater(similarity(reference,chosen), .65)
        canvas[60:660,:480] = foreground;canvas[60:660,480:] = foreground
        with self.assertRaisesRegex(ValueError,'SELFIE_MULTIPLE_FACES'):
            self.engine.enroll(cv2.imencode('.jpg',canvas)[1].tobytes())


if __name__ == "__main__": unittest.main()
