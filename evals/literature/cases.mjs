// Request cases with predeclared search plans (collect mode). The fixtures are
// synthetic, hand-authored controls and are not citable publications.
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

// Frozen retrieval set: publishers with open copies, author manuscripts in PMC,
// preprints, and subscription pages behind bot checks or institutional access.
export const retrievalDois = [
  { doi: '10.1038/s41586-021-03819-2', note: 'Nature, open access, PMC open data' },
  { doi: '10.1093/bioinformatics/btp324', note: 'OUP, PMC open data' },
  { doi: '10.1186/1471-2105-10-421', note: 'BMC, open access' },
  { doi: '10.1371/journal.pmed.0020124', note: 'PLOS, open access' },
  { doi: '10.1038/nature17946', note: 'Nature subscription, PMC author manuscript' },
  { doi: '10.1016/j.cell.2019.05.031', note: 'Cell subscription behind bot checks; bioRxiv preprint' },
  { doi: '10.1126/science.1225829', note: 'Science subscription behind bot checks' },
  { doi: '10.1038/nbt.3519', note: 'Nature Biotechnology subscription' },
  { doi: '10.1126/science.abj8754', note: 'Science, PMC author manuscript' },
  { doi: '10.1101/2022.07.20.500902', note: 'bioRxiv preprint' },
  { doi: '10.1093/nar/28.1.235', note: 'OUP, open on the publisher site' },
  { doi: '10.1073/pnas.1208507109', note: 'PNAS behind bot checks' },
  { doi: '10.1021/acs.jctc.5b00255', note: 'ACS, PDF text layer splits the title' },
  { doi: '10.1002/pro.3943', note: 'Wiley behind bot checks' },
  { doi: '10.48550/arXiv.1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017, note: 'arXiv DOI' },
];
