"""Source resources stay relative to the lab root, independent of cwd."""
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LabPaths:
    root: Path

    def __post_init__(self):
        object.__setattr__(self, 'root', Path(self.root).resolve())

    @classmethod
    def default(cls):
        return cls(Path(__file__).resolve().parents[1])

    @property
    def capability_contracts(self):
        return self.root / 'recipes' / 'capability-contracts.json'
