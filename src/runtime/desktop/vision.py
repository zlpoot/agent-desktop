"""在绑定窗口截图中查找项目内的图片模板。"""

from pathlib import Path


def match_visual_template(description, screenshot, project_dir):
    if not description.startswith("template:"):
        raise ValueError("视觉目标格式为 template:<项目内图片路径>")
    project = Path(project_dir).resolve()
    template = (project / description[len("template:"):]).resolve()
    if not template.is_relative_to(project) or not template.is_file():
        raise ValueError("视觉模板必须是项目目录内现有图片")
    import cv2
    import numpy as np
    screen = cv2.imdecode(np.fromfile(str(screenshot), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    pattern = cv2.imdecode(np.fromfile(str(template), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if screen is None or pattern is None or pattern.shape[0] > screen.shape[0] or pattern.shape[1] > screen.shape[1]:
        raise ValueError("视觉模板无法读取或尺寸大于窗口")
    if pattern.std() < 5:
        raise ValueError("视觉模板缺少可辨认的图像特征")
    score = cv2.matchTemplate(screen, pattern, cv2.TM_CCOEFF_NORMED)
    _, confidence, _, top_left = cv2.minMaxLoc(score)
    if confidence < 0.9:
        raise ValueError(f"模板匹配度不足：{confidence:.3f}")
    competing = score.copy()
    left = max(0, top_left[0] - pattern.shape[1])
    top = max(0, top_left[1] - pattern.shape[0])
    right = min(competing.shape[1], top_left[0] + pattern.shape[1] + 1)
    bottom = min(competing.shape[0], top_left[1] + pattern.shape[0] + 1)
    competing[top:bottom, left:right] = -1
    if competing.max() >= 0.9:
        raise ValueError("截图中存在多个相同视觉目标")
    x = top_left[0] + pattern.shape[1] // 2
    y = top_left[1] + pattern.shape[0] // 2
    return x, y, confidence
