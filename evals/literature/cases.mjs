// Synthetic, hand-authored control cases. These are not citable publications.
// Live mode uses only request/plan fields, never fixtures or gold annotations.
const fixture = (id, title, abstract, topics, relevant = true, downloadable = true, year = 2024) => ({
  id, title, abstract, topics, relevant, downloadable, year,
});
export const cases = [
  { id: 'ai-synthetic-biology', request: 'Find and save 3 papers about generative AI in synthetic biology, covering biological parts, genetic circuits and genomes.',
    count: 3, topics: ['biological parts', 'genetic circuits', 'genomes'], synonyms: ['generative design', 'machine learning'],
    queries: ['generative AI synthetic biology biological parts', 'machine learning genetic circuit design', 'generative models genome design'],
    fixtures: [fixture('a', 'AI biosecurity policy overview', 'Discusses governance, not methods for biological design.', [], false),
      fixture('b', 'Generative protein sequence design', 'Designs biological parts using a generative model and experimental validation.', ['biological parts'], true, false),
      fixture('c', 'Learning genetic circuit behavior', 'Predicts regulatory circuit behavior to guide circuit design.', ['genetic circuits']),
      fixture('d', 'Genome design with generative models', 'Models genome organization for synthetic genome design.', ['genomes']),
      fixture('e', 'Generative promoter design', 'Generates promoter sequences as programmable biological parts.', ['biological parts'])], selected: ['b', 'c', 'd', 'e'] },
  { id: 'enzyme-methods', request: 'Download 2 papers comparing machine-learning-guided enzyme engineering for substrate specificity and thermostability.',
    count: 2, topics: ['substrate specificity', 'thermostability'], synonyms: ['directed evolution', 'protein engineering'],
    queries: ['machine learning enzyme engineering substrate specificity', 'machine learning directed evolution thermostability'],
    fixtures: [fixture('a', 'Enzyme market outlook', 'An economic survey without engineering methods.', [], false),
      fixture('b', 'Learning enzyme substrate preference', 'Uses experimental activity data to predict and alter substrate specificity.', ['substrate specificity']),
      fixture('c', 'Protein stabilization with learned representations', 'Tests mutations selected to improve enzyme thermostability.', ['thermostability'])], selected: ['b', 'c'] },
  { id: 'chinese-date-constrained', request: '检索并保存2023至2025年间两篇关于单细胞基础模型的论文，覆盖扰动预测和跨组织泛化。',
    count: 2, topics: ['perturbation prediction', 'cross-tissue generalization'], synonyms: ['single-cell foundation model'], year_from: 2023, year_to: 2025,
    queries: ['single cell foundation model perturbation prediction', 'single cell foundation model cross tissue generalization'],
    fixtures: [fixture('a', 'Early single-cell clustering', 'A 2020 clustering method predating foundation models.', [], false, true, 2020),
      fixture('b', 'Foundation models for cellular perturbations', 'Evaluates prediction of cellular responses to perturbations.', ['perturbation prediction']),
      fixture('c', 'Cross-tissue evaluation of cell models', 'Tests transfer and generalization across held-out tissues.', ['cross-tissue generalization'], true, true, 2025)], selected: ['b', 'c'] },
  { id: 'sparse-evidence', request: 'Find and save 3 papers on machine learning for ectoine hydroxylase, covering substrate selectivity and thermostability.',
    count: 3, topics: ['substrate selectivity', 'thermostability'], synonyms: ['EctD', 'ectoine hydroxylase'],
    queries: ['machine learning ectoine hydroxylase substrate selectivity', 'EctD machine learning thermostability'],
    fixtures: [fixture('a', 'Ectoine production economics', 'Discusses manufacturing costs, not machine learning or hydroxylase engineering.', [], false),
      fixture('b', 'Learning hydroxylase substrate selectivity', 'A small study predicting EctD substrate selectivity; no thermostability evaluation.', ['substrate selectivity'])], selected: ['b'] },
];
