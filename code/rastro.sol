// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract RastroChainlink is IReceiver {
    enum StatusRegistro {
        PENDENTE,
        VALIDO,
        INVALIDO
    }

    struct Fazenda {
        address dono;
        uint8 status;
        uint256 atualizadoEm;
        bool existe;
    }

    struct DadosAnalise {
        uint8 deforestationStatus;
        uint8 embargoStatus;
        uint256 alertHectares;
        string dataSource;
        bytes32 sourceHash;
        string cidAnalise;
        string cidGemini;
    }

    mapping(string => Fazenda) public fazendas;
    mapping(string => string) public cidTerritorial;
    mapping(string => DadosAnalise) public analises;

    string[] private listaFazendas;

    address public owner;
    address public oracle;

    event FazendaCadastrada(string codigoCAR, address dono);
    event TerritorialRegistrado(string codigoCAR, uint8 status, string cid);
    event AnaliseRegistrada(string codigoCAR, string cidAnalise, string cidGemini);
    event OracleAlterado(address oracle);

    event ReportRecebido(address sender, bytes metadata, bytes report);
    event ReportAction(uint8 action);
    event ReportTerritorialDecodificado(
        string codigoCAR,
        uint8 status,
        string cid
    );
    event ReportAnaliseDecodificado(
        string codigoCAR,
        string cidAnalise,
        string cidGemini
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Somente owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle || msg.sender == owner, "Nao autorizado");
        _;
    }

    constructor() {
        owner = msg.sender;
        oracle = msg.sender;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function setOracle(address novoOracle) external onlyOwner {
        require(novoOracle != address(0), "Oracle zero");
        oracle = novoOracle;

        emit OracleAlterado(novoOracle);
    }

    function cadastrarCAR(string calldata codigoCAR) external {
        require(bytes(codigoCAR).length >= 10, "CAR invalido");
        require(!fazendas[codigoCAR].existe, "CAR ja cadastrado");

        fazendas[codigoCAR] = Fazenda({
            dono: msg.sender,
            status: uint8(StatusRegistro.PENDENTE),
            atualizadoEm: block.timestamp,
            existe: true
        });

        listaFazendas.push(codigoCAR);

        emit FazendaCadastrada(codigoCAR, msg.sender);
    }

    function registrarTerritorial(
        string memory codigoCAR,
        uint8 status,
        string memory cid
    ) public onlyOracle {
        _registrarTerritorial(codigoCAR, status, cid);
    }

    function registrarAnalise(
        string memory codigoCAR,
        DadosAnalise memory dados
    ) public onlyOracle {
        _registrarAnalise(codigoCAR, dados);
    }

    function _registrarTerritorial(
        string memory codigoCAR,
        uint8 status,
        string memory cid
    ) internal {
        require(fazendas[codigoCAR].existe, "CAR nao cadastrado");
        require(status <= uint8(StatusRegistro.INVALIDO), "Status invalido");

        fazendas[codigoCAR].status = status;
        fazendas[codigoCAR].atualizadoEm = block.timestamp;
        cidTerritorial[codigoCAR] = cid;

        emit TerritorialRegistrado(codigoCAR, status, cid);
    }

    function _registrarAnalise(
        string memory codigoCAR,
        DadosAnalise memory dados
    ) internal {
        require(fazendas[codigoCAR].existe, "CAR nao cadastrado");

        require(
            fazendas[codigoCAR].status == uint8(StatusRegistro.VALIDO),
            "CAR sem territorial valido"
        );

        require(dados.deforestationStatus <= 1, "Deforestation invalido");
        require(dados.embargoStatus <= 1, "Embargo invalido");

        analises[codigoCAR] = dados;
        fazendas[codigoCAR].atualizadoEm = block.timestamp;

        emit AnaliseRegistrada(
            codigoCAR,
            dados.cidAnalise,
            dados.cidGemini
        );
    }

    function onReport(
        bytes calldata metadata,
        bytes calldata report
    ) external {
        emit ReportRecebido(msg.sender, metadata, report);

        uint8 action = abi.decode(report, (uint8));

        emit ReportAction(action);

        if (action == 1) {
            (
                ,
                string memory codigoCAR,
                uint8 status,
                string memory cid
            ) = abi.decode(report, (uint8, string, uint8, string));

            emit ReportTerritorialDecodificado(
                codigoCAR,
                status,
                cid
            );

            _registrarTerritorial(codigoCAR, status, cid);
            return;
        }

        if (action == 2) {
            (
                ,
                string memory codigoCAR,
                DadosAnalise memory dados
            ) = abi.decode(report, (uint8, string, DadosAnalise));

            emit ReportAnaliseDecodificado(
                codigoCAR,
                dados.cidAnalise,
                dados.cidGemini
            );

            _registrarAnalise(codigoCAR, dados);
            return;
        }

        revert("Action invalida");
    }

    function listarTodos() external view returns (string[] memory) {
        return listaFazendas;
    }

    function totalFazendas() external view returns (uint256) {
        return listaFazendas.length;
    }

    function getFazenda(
        string calldata codigoCAR
    ) external view returns (Fazenda memory) {
        require(fazendas[codigoCAR].existe, "CAR nao existe");
        return fazendas[codigoCAR];
    }

    function statusCAR(
        string calldata codigoCAR
    ) external view returns (uint8) {
        require(fazendas[codigoCAR].existe, "CAR nao existe");
        return fazendas[codigoCAR].status;
    }

    function cidAnalise(
        string calldata codigoCAR
    ) external view returns (string memory) {
        return analises[codigoCAR].cidAnalise;
    }

    function cidGemini(
        string calldata codigoCAR
    ) external view returns (string memory) {
        return analises[codigoCAR].cidGemini;
    }
}
