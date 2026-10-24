// Pattern tags that explain why a move was an error (computed in app/js/backend/analysis/motifs.js).
export const MOTIF_LABELS = {
  allowed_mate: 'allowed a forced mate',
  missed_mate: 'missed a forced mate',
  hung_piece: 'left material en prise',
  allowed_fork: 'allowed a fork',
  allowed_tactic: 'allowed a tactic (lost material to a sequence)',
  missed_capture: 'missed winning material',
  missed_fork: 'missed a fork',
  missed_tactic: 'missed a tactic (material-winning sequence)',
  failed_conversion: 'let a winning position slip',
  time_trouble: 'erred in time trouble',
  positional: 'positional / strategic error',
};
